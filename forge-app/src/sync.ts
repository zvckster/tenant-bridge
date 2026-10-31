import {
  authorizeInbound,
  authorLabel,
  channelFor,
  commentShareable,
  type ConnectionKeys,
  DecryptError,
  type Envelope,
  inOutboundScope,
  markApplied,
  missingSeqs,
  open,
  type Payload,
  type PayloadOf,
  PayloadSchema,
  receive,
  receiveControl,
  requeue,
  shareFields,
  snapshotHash,
  takeReady,
  type TicketRef,
} from "@tb/protocol";
import { sanitizeAdf, withAuthor } from "./adf";
import { acceptOffer, syncAttachments } from "./attachments";
import * as jira from "./jira";
import { LockBusyError, withLock } from "./lock";
import { relay } from "./relay";
import {
  getCommentOrigin,
  getConnectionKeys,
  getInbox,
  getLocalCommentId,
  getMirrorByLocal,
  getMirrorByRef,
  getReconcileState,
  linkComment,
  listConnections,
  listMirrors,
  type LocalConnection,
  saveConnection,
  saveMirror,
  setInbox,
  setReconcileState,
  unlinkComment,
} from "./state";
import { type ActiveConnection, ackOutbox, activeConnections, EPOCH, Rejected, retransmit, send } from "./transport";

export { send };

const MIRROR_LABEL = "tb-mirror";

// ---------------------------------------------------------------- outbound

/** The shared view of one of my issues, or undefined if the policy doesn't share it. */
async function buildSnapshot(conn: ActiveConnection, issueId: string, myId: string): Promise<PayloadOf<"ticket.snapshot"> | undefined> {
  const issue = await jira.getIssue(issueId, conn.policy.outbound.customFields);
  if (!inOutboundScope(conn.policy, issue)) return undefined;
  if (!(await jira.matchesJql(issue.key, conn.policy.outbound.jql))) return undefined;
  const fields = shareFields(conn.policy, issue);
  if (fields.description !== undefined) fields.description = sanitizeAdf(fields.description);
  return {
    type: "ticket.snapshot",
    opId: crypto.randomUUID(),
    ref: { owner: myId, id: issue.id, key: issue.key },
    fields,
    updatedAt: issue.updatedAt,
  };
}

/** Shares the current state of one of my issues, then any attachments the partner lacks. */
async function pushSnapshot(conn: ActiveConnection, issueId: string, myId: string): Promise<void> {
  const snap = await buildSnapshot(conn, issueId, myId);
  if (!snap) return;
  await send(conn, snap);
  await syncAttachments(conn, issueId, snap.ref, myId);
}

interface ChangelogItem {
  field: string;
  fieldId?: string;
  toString?: string | null;
  to?: string | null;
}

/** A local user changed an issue: share it, or turn edits of a mirror into requests to its owner. */
export async function onLocalIssueChange(issueId: string, changelog: ChangelogItem[] = []): Promise<void> {
  const { identity } = await relay();
  const conns = await activeConnections();
  const mirror = await getMirrorByLocal(issueId);

  if (mirror) {
    const conn = conns.find((c) => c.id === mirror.connectionId);
    if (!conn) return;
    for (const item of changelog) {
      const fieldId = item.fieldId ?? item.field;
      if (fieldId === "status" && item.toString) {
        // Map my status name back to the partner's (inverse of inbound.statusMap).
        const partnerStatus =
          Object.entries(conn.policy.inbound.statusMap).find(([, mine]) => mine === item.toString)?.[0] ?? item.toString;
        await send(conn, { type: "status.request", opId: crypto.randomUUID(), ticket: mirror.ref, to: partnerStatus });
      } else if (item.field === "Attachment" || fieldId === "attachment") {
        await syncAttachments(conn, issueId, mirror.ref, identity.installId);
      } else if (fieldId === "summary" || fieldId === "priority" || fieldId === "duedate") {
        const field = fieldId === "duedate" ? "dueDate" : fieldId;
        const value = fieldId === "duedate" ? item.to : item.toString;
        await send(conn, { type: "field.request", opId: crypto.randomUUID(), ticket: mirror.ref, field, value });
      }
    }
    return;
  }

  for (const conn of conns) await pushSnapshot(conn, issueId, identity.installId);
}

/** Connections an issue is shared on, with the ref the partner knows it by. */
async function shareTargets(issueId: string, me: string): Promise<Array<{ conn: ActiveConnection; ref: TicketRef }>> {
  const conns = await activeConnections();
  const mirror = await getMirrorByLocal(issueId);
  if (mirror) {
    const conn = conns.find((c) => c.id === mirror.connectionId);
    return conn ? [{ conn, ref: mirror.ref }] : [];
  }
  const issue = await jira.getIssue(issueId);
  const targets: Array<{ conn: ActiveConnection; ref: TicketRef }> = [];
  for (const conn of conns) {
    if (inOutboundScope(conn.policy, issue) && (await jira.matchesJql(issue.key, conn.policy.outbound.jql))) {
      targets.push({ conn, ref: { owner: me, id: issue.id, key: issue.key } });
    }
  }
  return targets;
}

/** A local user commented (or edited a comment). Partner comments are posted by the app and filtered out by ignoreSelf. */
export async function onLocalComment(issueId: string, commentId: string): Promise<void> {
  if (await getCommentOrigin(commentId)) return;
  const { identity } = await relay();
  const comment = await jira.getComment(issueId, commentId);

  for (const { conn, ref } of await shareTargets(issueId, identity.installId)) {
    if (!commentShareable(conn.policy, comment)) continue;
    await send(conn, {
      type: "comment.upsert",
      opId: crypto.randomUUID(),
      ticket: ref,
      origin: { tenant: identity.installId, id: comment.id },
      author: authorLabel(conn.policy, comment.authorName),
      body: sanitizeAdf(comment.body),
      updatedAt: comment.updated,
    });
  }
}

/** A local user deleted their comment: remove the partner's copy. */
export async function onLocalCommentDeleted(issueId: string, commentId: string): Promise<void> {
  if (await getCommentOrigin(commentId)) return; // the partner's comment; theirs to delete
  const { identity } = await relay();
  for (const { conn, ref } of await shareTargets(issueId, identity.installId)) {
    await send(conn, { type: "comment.delete", opId: crypto.randomUUID(), ticket: ref, origin: { tenant: identity.installId, id: commentId } });
  }
}

/** A local user attached a file: send it wherever the issue is shared. */
export async function onLocalAttachment(issueId: string): Promise<void> {
  const { identity } = await relay();
  for (const { conn, ref } of await shareTargets(issueId, identity.installId)) {
    await syncAttachments(conn, issueId, ref, identity.installId);
  }
}

// ---------------------------------------------------------------- inbound

/** Resolves a ticket ref to the local issue id: my own ticket, or my mirror of theirs. */
async function localIssueFor(conn: ActiveConnection, ref: TicketRef, me: string): Promise<string> {
  if (ref.owner === me) return ref.id;
  const m = await getMirrorByRef(conn.id, ref.id);
  if (!m) throw new Rejected("unknown_ticket");
  return m.localIssueId;
}

function jiraFields(fields: Partial<PayloadOf<"ticket.snapshot">["fields"]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (fields.summary !== undefined) out.summary = fields.summary;
  if (fields.description !== undefined) out.description = sanitizeAdf(fields.description);
  if (fields.dueDate !== undefined) out.duedate = fields.dueDate;
  return out;
}

async function applySnapshot(conn: ActiveConnection, p: PayloadOf<"ticket.snapshot">): Promise<void> {
  const existing = await getMirrorByRef(conn.id, p.ref.id);
  const fields = jiraFields(p.fields);
  let localId: string;
  if (existing) {
    localId = existing.localIssueId;
    await jira.updateIssue(localId, fields);
  } else {
    localId = await jira.createIssue(conn.policy.inbound.targetSpace, conn.policy.inbound.issueType, {
      ...fields,
      labels: [MIRROR_LABEL],
    });
    // Link first, so a failure in any later step retries as an update, never a second create.
    await saveMirror({ connectionId: conn.id, ref: p.ref, localIssueId: localId });
    await jira.setIssueProperty(localId, "tb.mirror", { ref: p.ref, connectionId: conn.id });
  }
  const partner = p.fields.status;
  const landed = await mirrorStatus(conn, localId, partner);
  // When our workflow can't show the partner's exact status (e.g. their custom
  // "Waiting for customer"), say so on the ticket, once per change.
  if (landed !== partner.name && existing?.partnerStatus !== partner.name) {
    await jira.addComment(localId, statusNote(partner.name));
  }
  await saveMirror({ connectionId: conn.id, ref: p.ref, localIssueId: localId, hash: snapshotHash(p), partnerStatus: partner.name });
}

/**
 * Puts the mirror in the closest status to the partner's: the admin's mapping or the
 * same name if a transition exists, otherwise any status of the same category
 * (to do / in progress / done). Returns the status the mirror ends up in.
 */
async function mirrorStatus(conn: ActiveConnection, localId: string, partner: { name: string; category: string }): Promise<string> {
  const wanted = conn.policy.inbound.statusMap[partner.name] ?? partner.name;
  const current = (await jira.getIssue(localId)).fields.status;
  if (current.name === wanted) return current.name;
  const transitions = await jira.getTransitions(localId);
  const exact = transitions.find((t) => t.to.name === wanted);
  const sameCategory =
    current.category === partner.category ? undefined : transitions.find((t) => t.to.category === partner.category);
  const t = exact ?? sameCategory;
  if (!t) return current.name;
  await jira.doTransition(localId, t.id);
  return t.to.name;
}

const statusNote = (name: string) => ({
  type: "doc",
  version: 1,
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "🔄 Partner status: " },
        { type: "text", text: name, marks: [{ type: "strong" }] },
      ],
    },
  ],
});

const FIELD_TO_JIRA: Record<string, (v: unknown) => Record<string, unknown>> = {
  summary: (v) => ({ summary: v }),
  priority: (v) => ({ priority: { name: v } }),
  dueDate: (v) => ({ duedate: v }),
  labels: (v) => ({ labels: v }),
  description: (v) => ({ description: sanitizeAdf(v) }),
};

async function apply(conn: ActiveConnection, p: Payload, me: string): Promise<void> {
  // Facts the policy needs, looked up locally (never taken from the partner).
  let existingOriginTenant: string | undefined;
  let currentStatus: string | undefined;
  if (p.type === "comment.upsert" || p.type === "comment.delete") {
    const localId = await getLocalCommentId(conn.id, p.origin);
    if (localId) existingOriginTenant = (await getCommentOrigin(localId))?.tenant;
  }
  if (p.type === "status.request" && p.ticket.owner === me) {
    currentStatus = (await jira.getIssue(p.ticket.id)).fields.status.name;
  }

  const decision = authorizeInbound(conn.policy, p, { me, partner: conn.peer, existingOriginTenant, currentStatus });
  if (!decision.allow) throw new Rejected(decision.reason);

  switch (p.type) {
    case "ticket.snapshot":
      return applySnapshot(conn, p);

    case "comment.upsert": {
      const issueId = await localIssueFor(conn, p.ticket, me);
      const body = withAuthor(p.author, sanitizeAdf(p.body));
      const localId = await getLocalCommentId(conn.id, p.origin);
      if (localId) return jira.updateComment(issueId, localId, body);
      return linkComment(conn.id, p.origin, await jira.addComment(issueId, body));
    }

    case "comment.delete": {
      const issueId = await localIssueFor(conn, p.ticket, me);
      const localId = await getLocalCommentId(conn.id, p.origin);
      if (!localId) return;
      await jira.deleteComment(issueId, localId);
      return unlinkComment(conn.id, p.origin, localId);
    }

    case "status.request":
      if (!(await jira.transitionTo(p.ticket.id, p.to))) throw new Rejected("transition_unavailable");
      // ignoreSelf hides our own change from the event trigger, so share the result explicitly.
      return pushSnapshot(conn, p.ticket.id, me);

    case "field.request": {
      const map = FIELD_TO_JIRA[p.field] ?? ((v: unknown) => ({ [p.field]: v }));
      await jira.updateIssue(p.ticket.id, map(p.value));
      return pushSnapshot(conn, p.ticket.id, me);
    }

    case "ticket.create.request": {
      const id = await jira.createIssue(conn.policy.outbound.spaces[0]!, conn.policy.inbound.issueType, jiraFields(p.fields));
      return pushSnapshot(conn, id, me);
    }

    case "policy.summary":
      await saveConnection({ ...conn, partnerCapabilities: p.capabilities });
      return;

    case "rejected":
      console.warn(`partner rejected seq ${p.seq}: ${p.reason}`);
      return;

    case "attachment.offer":
      return acceptOffer(conn, p, await localIssueFor(conn, p.ticket, me));

    case "attachment.chunk":
      return; // legacy chunked transfer; files now travel as relay blobs

    case "reaction.set": // Jira's public REST API has no comment reactions yet
      throw new Rejected("not_supported_yet");

    case "manifest":
      return answerManifest(conn, p, me);

    case "resync.request":
      for (const ref of p.refs) if (ref.owner === me) await pushSnapshot(conn, ref.id, me);
      return;

    case "ack":
    case "nack":
      throw new Error("control payload on data channel");
  }
}

async function handleControl(conn: LocalConnection, p: Payload): Promise<void> {
  if (p.type === "ack") {
    await ackOutbox(conn, p.appliedUpTo);
  } else if (p.type === "nack") {
    await retransmit(conn, p.missing);
  }
}

function decrypt(keys: ConnectionKeys, env: Envelope): Payload | undefined {
  try {
    const p = PayloadSchema.parse(open(keys, env, [EPOCH]));
    // A payload must arrive on its own channel; anything else is dropped.
    return channelFor(p.type) === env.ch ? p : undefined;
  } catch (err) {
    if (err instanceof DecryptError) console.warn(`dropping undecryptable envelope seq ${env.seq}`);
    else console.warn(`dropping malformed payload seq ${env.seq}: ${String(err)}`);
    return undefined;
  }
}

/** Pulls the mailbox, applies everything in order, acks the relay and the partner. */
export async function processMailbox(maxRounds = 5): Promise<void> {
  const { client, identity } = await relay();
  const conns = new Map((await listConnections()).map((c) => [c.id, c]));

  for (let round = 0; round < maxRounds; round++) {
    // Small batches keep each locked section well inside the lock TTL and function timeout.
    const envs = await client.mailbox(MAILBOX_BATCH);
    if (envs.length === 0) return;

    const byConn = new Map<string, Envelope[]>();
    for (const e of envs) byConn.set(e.connectionId, [...(byConn.get(e.connectionId) ?? []), e]);

    for (const [connId, list] of byConn) {
      const conn = conns.get(connId);
      const keys = await getConnectionKeys(connId);
      if (!conn || conn.status !== "active" || !conn.policy || !conn.peer || !keys) {
        // Not ours to process (revoked, unknown): drop it from the relay.
        await client.ack(connId, seqsOf(list, "d"), seqsOf(list, "c"));
        continue;
      }
      try {
        await withLock(`inbox:${connId}`, () => processConnection(conn as ActiveConnection, keys, list, identity.installId));
      } catch (err) {
        if (!(err instanceof LockBusyError)) throw err;
        // Another invocation is working this inbox; the mail stays on the relay for it.
      }
    }
  }
}

const MAILBOX_BATCH = 25;
const seqsOf = (list: Envelope[], ch: "c" | "d") => list.filter((e) => e.ch === ch).map((e) => e.seq);

/** Handles one connection's batch. Runs under the inbox lock so envelopes are applied once, in order. */
async function processConnection(conn: ActiveConnection, keys: ConnectionKeys, list: Envelope[], me: string): Promise<void> {
  const { client } = await relay();
  let inbox = await getInbox(conn.id);
  let needAck = false;
  const notKept = new Set<number>();

  for (const env of [...list].sort((a, b) => a.seq - b.seq)) {
    const payload = decrypt(keys, env);
    if (!payload) continue; // relay-acked below; the sender retransmits the original

    if (env.ch === "c") {
      const r = receiveControl(inbox, env);
      inbox = r.state;
      if (r.fresh) await handleControl(conn, payload);
      continue;
    }
    const r = receive(inbox, env);
    inbox = r.state;
    if (!r.kept) notKept.add(env.seq);
    if (r.duplicate) needAck = true; // the sender is missing our ack
  }

  // Everything now contiguous, including envelopes left from a run that stopped early.
  const taken = takeReady(inbox);
  inbox = taken.state;
  const ready = taken.ready;

  for (let i = 0; i < ready.length; i++) {
    const env = ready[i]!;
    const payload = decrypt(keys, env);
    try {
      if (payload) await apply(conn, payload, me);
    } catch (err) {
      if (!(err instanceof Rejected)) {
        // Transient (e.g. Jira unavailable): keep this and the rest for the next run.
        console.warn(`apply failed on ${conn.id} seq ${env.seq}: ${String(err)}`);
        inbox = requeue(inbox, ready.slice(i));
        break;
      }
      await send(conn, { type: "rejected", seq: env.seq, opId: (payload as { opId?: string } | undefined)?.opId, reason: err.message });
      // A refused edit of my ticket: resend the true state so the partner's mirror reverts.
      if (payload && (payload.type === "status.request" || payload.type === "field.request") && payload.ticket.owner === me) {
        await pushSnapshot(conn, payload.ticket.id, me);
      }
    }
    inbox = markApplied(inbox, env.seq);
    needAck = true;
  }

  await setInbox(conn.id, inbox);
  if (list.length > 0) await client.ack(conn.id, seqsOf(list, "d").filter((s) => !notKept.has(s)), seqsOf(list, "c"));
  if (needAck) await send(conn, { type: "ack", appliedUpTo: inbox.appliedUpTo });
}

// ---------------------------------------------------------------- reconciliation

export const RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MANIFEST_CHUNK = 500;
const CATCH_UP_MAX = 200;

/**
 * Owner side of reconciliation: the partner lists the mirrors it holds and their hashes;
 * anything that differs from my current shared view is sent again.
 */
async function answerManifest(conn: ActiveConnection, p: PayloadOf<"manifest">, me: string): Promise<void> {
  for (const item of p.items) {
    if (item.ref.owner !== me) continue;
    const snap = await buildSnapshot(conn, item.ref.id, me);
    // TODO: tell the partner when a ticket left the shared scope, so it can archive the mirror.
    if (snap && snapshotHash(snap) !== item.hash) await send(conn, snap);
  }
}

/**
 * Catches what events missed, in both roles: as owner, re-shares my tickets updated since
 * the last run; as mirror holder, sends the owner a manifest of what I hold.
 */
export async function reconcile(conn: ActiveConnection, me: string, now = Date.now()): Promise<boolean> {
  const state = await getReconcileState(conn.id);
  if (state && now - state.lastRunAt < RECONCILE_INTERVAL_MS) return false;

  // Overlap the window by 10 minutes so nothing falls between runs.
  const sinceMinutes = state ? (now - state.lastRunAt) / 60_000 + 10 : undefined;
  const ids = await jira.searchIds(jira.scopeJql(conn.policy.outbound, sinceMinutes), CATCH_UP_MAX);
  for (const id of ids) await pushSnapshot(conn, id, me);

  const mirrors = await listMirrors(conn.id);
  for (const m of mirrors) await syncAttachments(conn, m.localIssueId, m.ref, me);
  for (let i = 0; i < mirrors.length; i += MANIFEST_CHUNK) {
    const items = mirrors.slice(i, i + MANIFEST_CHUNK).map((m) => ({ ref: m.ref, hash: m.hash ?? "" }));
    await send(conn, { type: "manifest", items });
  }
  await setReconcileState(conn.id, { lastRunAt: now });
  return true;
}

/** Scheduled: catch up on mail, retry what a Jira outage held back, retransmit, report gaps. */
export async function tick(): Promise<void> {
  await processMailbox();
  const { identity } = await relay();
  for (const conn of await activeConnections()) {
    const keys = await getConnectionKeys(conn.id);
    if (keys && Object.keys((await getInbox(conn.id)).pending).length > 0) {
      try {
        await withLock(`inbox:${conn.id}`, () => processConnection(conn, keys, [], identity.installId));
      } catch (err) {
        if (!(err instanceof LockBusyError)) throw err;
      }
    }
    await retransmit(conn);
    const missing = missingSeqs(await getInbox(conn.id));
    if (missing.length > 0) await send(conn, { type: "nack", missing });
    await reconcile(conn, identity.installId);
  }
}
