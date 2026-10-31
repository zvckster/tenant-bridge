import api, { route, type WebTriggerResponse } from "@forge/api";
import Resolver from "@forge/resolver";
import { acceptInvite, approve, createInvite, decline, refreshConnections, revoke, savePolicy } from "./pairing";
import { runReceiveAttachment, runSendAttachment } from "./attachments";
import { enqueue, type Job } from "./jobs";
import { fingerprint } from "@tb/protocol";
import * as jira from "./jira";
import { randomName } from "./names";
import { ensureIdentity, relay } from "./relay";
import { getSettings, type SiteSettings, setSettings } from "./state";
import { onLocalAttachment, onLocalComment, onLocalCommentDeleted, onLocalIssueChange, processMailbox, tick } from "./sync";

// ---------------------------------------------------------------- admin UI backend

/** Defence in depth: the admin page is admin-only, but every call re-checks it. */
async function requireAdmin(): Promise<void> {
  const res = await api.asUser().requestJira(route`/rest/api/3/mypermissions?permissions=ADMINISTER`, {
    headers: { Accept: "application/json" },
  });
  const body = (await res.json()) as { permissions?: { ADMINISTER?: { havePermission?: boolean } } };
  if (!body.permissions?.ADMINISTER?.havePermission) throw new Error("Jira administrator permission required");
}

const resolver = new Resolver();
const admin = <P, R>(fn: (payload: P) => Promise<R>) =>
  async ({ payload }: { payload: P }) => {
    await requireAdmin();
    return fn(payload);
  };

/** Month-to-date traffic per connection, from the relay's metadata (no content). */
async function usageByConnection(): Promise<Record<string, { sentBytes: number; sentMessages: number; receivedBytes: number; receivedMessages: number }>> {
  const now = new Date();
  const from = `${now.toISOString().slice(0, 7)}-01`;
  const to = now.toISOString().slice(0, 10);
  const res = (await (await relay()).client.usage(from, to)) as {
    rows: Array<{ connectionId: string; direction: "in" | "out"; messages: number; bytes: number }>;
  };
  const out: Record<string, { sentBytes: number; sentMessages: number; receivedBytes: number; receivedMessages: number }> = {};
  for (const r of res.rows) {
    const u = (out[r.connectionId] ??= { sentBytes: 0, sentMessages: 0, receivedBytes: 0, receivedMessages: 0 });
    if (r.direction === "out") {
      u.sentBytes += r.bytes;
      u.sentMessages += r.messages;
    } else {
      u.receivedBytes += r.bytes;
      u.receivedMessages += r.messages;
    }
  }
  return out;
}

/** Everything the admin page shows, in one call (it refreshes every few seconds). */
async function overview() {
  const [connections, settings, site, identity] = await Promise.all([refreshConnections(), getSettings(), jira.siteUrl(), ensureIdentity()]);
  let usage: Awaited<ReturnType<typeof usageByConnection>> = {};
  try {
    usage = await usageByConnection();
  } catch (err) {
    console.warn(`usage unavailable: ${String(err)}`);
  }
  return {
    site,
    settings: settings ?? { displayName: site, mode: "site" as const },
    myFingerprint: fingerprint(identity.keys),
    connections: connections.map((c) => ({ ...c, usage: usage[c.id] ?? null })),
  };
}

resolver.define("overview", admin(() => overview()));
resolver.define("saveSettings", admin((p: SiteSettings) => setSettings({ mode: p.mode, displayName: p.displayName.trim().slice(0, 100) })));
resolver.define("suggestName", admin(async () => ({ name: randomName() })));
resolver.define("listSpaces", admin(() => jira.listSpaces()));
resolver.define("spaceStatuses", admin((p: { key: string }) => jira.spaceStatuses(p.key)));
resolver.define("listLabels", admin(() => jira.listLabels()));
resolver.define("listCustomFields", admin(() => jira.listCustomFields()));
resolver.define("createInvite", admin(() => createInvite()));
resolver.define("acceptInvite", admin((p: { code: string }) => acceptInvite(p)));
resolver.define("approve", admin((p: { connectionId: string }) => approve(p.connectionId)));
resolver.define("decline", admin((p: { connectionId: string }) => decline(p.connectionId)));
resolver.define("revoke", admin((p: { connectionId: string }) => revoke(p.connectionId)));
resolver.define("savePolicy", admin((p: { connectionId: string; policy: unknown }) => savePolicy(p.connectionId, p.policy)));

export const handler = resolver.getDefinitions();

// ---------------------------------------------------------------- Jira events

interface IssueEvent {
  eventType: string;
  issue?: { id: string; key: string };
  comment?: { id: string };
  // TODO(verify): exact payload of avi:jira:created:attachment; we accept either shape.
  attachment?: { id: string; issueId?: string };
  changelog?: { items?: Array<{ field: string; fieldId?: string; toString?: string | null; to?: string | null }> };
}

/** Manifest uses filter.ignoreSelf, so changes the app makes itself never loop back here. */
export async function onIssueEvent(event: IssueEvent): Promise<void> {
  const issueId = event.issue?.id ?? event.attachment?.issueId;
  if (!issueId) return; // reconciliation picks up anything we can't place
  switch (event.eventType) {
    case "avi:jira:commented:issue":
      if (event.comment) await onLocalComment(issueId, event.comment.id);
      return;
    case "avi:jira:deleted:comment":
      if (event.comment) await onLocalCommentDeleted(issueId, event.comment.id);
      return;
    case "avi:jira:created:attachment":
      return onLocalAttachment(issueId);
    default:
      return onLocalIssueChange(issueId, event.changelog?.items);
  }
}

// ---------------------------------------------------------------- relay ping, schedule, jobs

/** The relay pings this URL when mail is waiting. The ping carries no data. */
export async function onRelayPing(): Promise<WebTriggerResponse> {
  try {
    await enqueue({ kind: "mailbox" }); // processed by the job worker, one at a time
  } catch (err) {
    console.warn(`could not queue mailbox job: ${String(err)}`); // the scheduled tick catches up
  }
  return { statusCode: 204, headers: {}, body: "" };
}

export async function onTick(): Promise<void> {
  await refreshConnections();
  await enqueue({ kind: "tick" });
}

/** Async event consumer (manifest `consumer` → job-worker): long-running work with a generous timeout. */
export async function jobs(event: { body: Job }): Promise<void> {
  const job = event.body;
  console.log(`job start: ${job.kind}`);
  switch (job.kind) {
    case "mailbox":
      return processMailbox();
    case "tick":
      return tick();
    case "sendAttachment":
      return runSendAttachment(job);
    case "receiveAttachment":
      return runReceiveAttachment(job);
  }
}
