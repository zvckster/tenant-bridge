import { kvs } from "@forge/kvs";
import {
  type Bundle,
  type ConnectionKeys,
  type Envelope,
  type IdentityKeys,
  type InboxState,
  type Invite,
  type Origin,
  type OutboxEntry,
  type Policy,
  PolicySchema,
  type TicketRef,
} from "@tb/protocol";

/**
 * Everything the app persists, in Forge KVS on the tenant itself.
 * Private keys, pairing secrets and connection keys use secret storage.
 * KVS values are size-limited (~240 KiB), so queued envelopes are stored one per key.
 * Callers serialize outbox/inbox updates with withLock() (see lock.ts).
 */

export interface Identity {
  installId: string;
  keys: IdentityKeys;
  registered: boolean;
}

export type LocalStatus = "awaiting_partner" | "pending_approval" | "awaiting_confirm" | "active" | "revoked";

export interface LocalConnection {
  id: string;
  role: "inviter" | "acceptor";
  inviteId: string;
  status: LocalStatus;
  peer?: string;
  peerBundle?: Bundle;
  peerFingerprint?: string;
  policy?: Policy;
  /** What the partner says we may do on its tickets. For display only, never for enforcement. */
  partnerCapabilities?: Record<string, unknown>;
  createdAt: number;
}

/** Where a mirrored partner ticket lives locally. */
export interface MirrorLink {
  connectionId: string;
  ref: TicketRef; // partner-owned ref
  localIssueId: string;
  /** snapshotHash of the last snapshot applied; compared during reconciliation. */
  hash?: string;
  /** The partner's status name last seen, so a status note is posted once per change. */
  partnerStatus?: string;
}

const K = {
  identity: "identity",
  settings: "settings",
  invite: (inviteId: string) => `invite:${inviteId}`,
  connIndex: "conn-index",
  conn: (id: string) => `conn:${id}`,
  connKeys: (id: string) => `conn-keys:${id}`,
  pairSecret: (id: string) => `pair-secret:${id}`,
  inbox: (id: string) => `inbox:${id}`,
  inboxEnv: (id: string, seq: number) => `inbox-env:${id}:${seq}`,
  outbox: (id: string) => `outbox:${id}`,
  outboxEntry: (id: string, seq: number) => `outbox-entry:${id}:${seq}`,
  mirrorByRef: (connId: string, partnerIssueId: string) => `mirror:${connId}:${partnerIssueId}`,
  mirrorByLocal: (localIssueId: string) => `mirror-local:${localIssueId}`,
  mirrorIndex: (connId: string) => `mirror-index:${connId}`,
  reconcile: (connId: string) => `reconcile:${connId}`,
  attOrigin: (localAttId: string) => `a-origin:${localAttId}`,
  attLocal: (connId: string, tenant: string, originId: string) => `a-local:${connId}:${tenant}:${originId}`,
  attSent: (connId: string, localAttId: string) => `a-sent:${connId}:${localAttId}`,
  attIncoming: (connId: string, tenant: string, originId: string) => `a-in:${connId}:${tenant}:${originId}`,
  commentOrigin: (localCommentId: string) => `c-origin:${localCommentId}`,
  thread: (connId: string, localIssueId: string) => `thread:${connId}:${localIssueId}`,
  commentLocal: (connId: string, tenant: string, originId: string) => `c-local:${connId}:${tenant}:${originId}`,
};

export const getIdentity = () => kvs.getSecret<Identity>(K.identity);
export const setIdentity = (i: Identity) => kvs.setSecret(K.identity, i);

export const getInvite = (inviteId: string) => kvs.getSecret<Invite>(K.invite(inviteId));
export const setInvite = (i: Invite) => kvs.setSecret(K.invite(i.inviteId), i);
export const deleteInvite = (inviteId: string) => kvs.deleteSecret(K.invite(inviteId));

/**
 * Stored rules may predate newer policy fields; parsing applies the schema defaults so
 * code can rely on every field (e.g. outbound.labels) being present.
 */
function normalize(c: LocalConnection | undefined): LocalConnection | undefined {
  if (!c?.policy) return c;
  const parsed = PolicySchema.safeParse(c.policy);
  return parsed.success ? { ...c, policy: parsed.data } : c;
}

export async function listConnections(): Promise<LocalConnection[]> {
  const ids = (await kvs.get<string[]>(K.connIndex)) ?? [];
  const all = await Promise.all(ids.map(async (id) => normalize(await kvs.get<LocalConnection>(K.conn(id)))));
  return all.filter((c): c is LocalConnection => !!c);
}

export const getConnection = async (id: string) => normalize(await kvs.get<LocalConnection>(K.conn(id)));

export async function saveConnection(c: LocalConnection) {
  const ids = (await kvs.get<string[]>(K.connIndex)) ?? [];
  if (!ids.includes(c.id)) await kvs.set(K.connIndex, [...ids, c.id]);
  await kvs.set(K.conn(c.id), c);
}

export const getConnectionKeys = (id: string) => kvs.getSecret<ConnectionKeys>(K.connKeys(id));
export const setConnectionKeys = (k: ConnectionKeys) => kvs.setSecret(K.connKeys(k.connectionId), k);
export const deleteConnectionKeys = (id: string) => kvs.deleteSecret(K.connKeys(id));

/** Acceptor keeps the pairing secret until the inviter's confirm MAC is verified. */
export const getPairSecret = (connId: string) => kvs.getSecret<{ secret: string; inviteId: string }>(K.pairSecret(connId));
export const setPairSecret = (connId: string, v: { secret: string; inviteId: string }) => kvs.setSecret(K.pairSecret(connId), v);
export const deletePairSecret = (connId: string) => kvs.deleteSecret(K.pairSecret(connId));

// ---- inbox: meta in one key, each buffered envelope in its own key

interface InboxMeta {
  appliedUpTo: number;
  ctrlSeen: number;
  pendingSeqs: number[];
}

export async function getInbox(id: string): Promise<InboxState> {
  const meta = (await kvs.get<InboxMeta>(K.inbox(id))) ?? { appliedUpTo: 0, ctrlSeen: 0, pendingSeqs: [] };
  const pending: Record<number, Envelope> = {};
  for (const seq of meta.pendingSeqs) {
    const env = await kvs.get<Envelope>(K.inboxEnv(id, seq));
    if (env) pending[seq] = env;
  }
  return { appliedUpTo: meta.appliedUpTo, ctrlSeen: meta.ctrlSeen, pending };
}

export async function setInbox(id: string, s: InboxState): Promise<void> {
  const before = new Set((await kvs.get<InboxMeta>(K.inbox(id)))?.pendingSeqs ?? []);
  const after = Object.keys(s.pending).map(Number);
  for (const seq of after) if (!before.has(seq)) await kvs.set(K.inboxEnv(id, seq), s.pending[seq]);
  await kvs.set(K.inbox(id), { appliedUpTo: s.appliedUpTo, ctrlSeen: s.ctrlSeen, pendingSeqs: after });
  for (const seq of before) if (!(seq in s.pending)) await kvs.delete(K.inboxEnv(id, seq));
}

// ---- outbox: counters + list of unacked data seqs, each entry in its own key

export interface OutboxMeta {
  nextSeq: number;
  nextCtrlSeq: number;
  seqs: number[]; // unacknowledged data envelopes
}

export const getOutboxMeta = async (id: string): Promise<OutboxMeta> =>
  (await kvs.get<OutboxMeta>(K.outbox(id))) ?? { nextSeq: 1, nextCtrlSeq: 1, seqs: [] };
export const setOutboxMeta = (id: string, m: OutboxMeta) => kvs.set(K.outbox(id), m);
export const getOutboxEntry = (id: string, seq: number) => kvs.get<OutboxEntry>(K.outboxEntry(id, seq));
export const setOutboxEntry = (id: string, e: OutboxEntry) => kvs.set(K.outboxEntry(id, e.env.seq), e);
export const deleteOutboxEntry = (id: string, seq: number) => kvs.delete(K.outboxEntry(id, seq));

export const getMirrorByRef = (connId: string, partnerIssueId: string) => kvs.get<MirrorLink>(K.mirrorByRef(connId, partnerIssueId));
export const getMirrorByLocal = (localIssueId: string) => kvs.get<MirrorLink>(K.mirrorByLocal(localIssueId));
export async function saveMirror(m: MirrorLink) {
  await kvs.set(K.mirrorByRef(m.connectionId, m.ref.id), m);
  await kvs.set(K.mirrorByLocal(m.localIssueId), m);
  const index = (await kvs.get<string[]>(K.mirrorIndex(m.connectionId))) ?? [];
  if (!index.includes(m.ref.id)) await kvs.set(K.mirrorIndex(m.connectionId), [...index, m.ref.id]);
}

/** All mirrors of one connection. TODO(scale): page this with kvs.query() past a few thousand. */
export async function listMirrors(connId: string): Promise<MirrorLink[]> {
  const index = (await kvs.get<string[]>(K.mirrorIndex(connId))) ?? [];
  const all = await Promise.all(index.map((id) => kvs.get<MirrorLink>(K.mirrorByRef(connId, id))));
  return all.filter((m): m is MirrorLink => !!m);
}

export interface ReconcileState {
  lastRunAt: number;
}
export const getReconcileState = (connId: string) => kvs.get<ReconcileState>(K.reconcile(connId));
export const setReconcileState = (connId: string, s: ReconcileState) => kvs.set(K.reconcile(connId), s);

/** Origin of a local comment that came from the partner (absent = authored locally). */
export const getCommentOrigin = (localCommentId: string) => kvs.get<Origin & { connectionId: string }>(K.commentOrigin(localCommentId));
export const getLocalCommentId = (connId: string, origin: Origin) => kvs.get<string>(K.commentLocal(connId, origin.tenant, origin.id));
export async function linkComment(connId: string, origin: Origin, localCommentId: string) {
  await kvs.set(K.commentOrigin(localCommentId), { ...origin, connectionId: connId });
  await kvs.set(K.commentLocal(connId, origin.tenant, origin.id), localCommentId);
}
export async function unlinkComment(connId: string, origin: Origin, localCommentId: string) {
  await kvs.delete(K.commentOrigin(localCommentId));
  await kvs.delete(K.commentLocal(connId, origin.tenant, origin.id));
}

// ---- attachments

/** Set when an attachment was received from the partner (absent = uploaded locally). */
export const getAttachmentOrigin = (localAttId: string) => kvs.get<Origin & { connectionId: string }>(K.attOrigin(localAttId));
export const getLocalAttachmentId = (connId: string, origin: Origin) => kvs.get<string>(K.attLocal(connId, origin.tenant, origin.id));
export async function linkAttachment(connId: string, origin: Origin, localAttId: string) {
  await kvs.set(K.attOrigin(localAttId), { ...origin, connectionId: connId });
  await kvs.set(K.attLocal(connId, origin.tenant, origin.id), localAttId);
}

/** Outbound progress per attachment and connection: queued for sending, or done. */
export interface SendState {
  state: "sending" | "done";
  at: number;
}
export const getSendState = (connId: string, localAttId: string) => kvs.get<SendState>(K.attSent(connId, localAttId));
export const setSendState = (connId: string, localAttId: string, v: SendState) => kvs.set(K.attSent(connId, localAttId), v);

/** An attachment being received: the accepted offer, waiting for its blob to be fetched. */
export interface IncomingAttachment {
  localIssueId: string;
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
  blobId: string;
  blobKey: string;
}
export const getIncoming = (connId: string, o: Origin) => kvs.get<IncomingAttachment>(K.attIncoming(connId, o.tenant, o.id));
export const setIncoming = (connId: string, o: Origin, v: IncomingAttachment) => kvs.set(K.attIncoming(connId, o.tenant, o.id), v);
export const deleteIncoming = (connId: string, o: Origin) => kvs.delete(K.attIncoming(connId, o.tenant, o.id));

// ---- shared thread: the comments of one ticket that both sides can see, in local order.
// Used to detect partner replies that crossed in transit (internal comments never count).

const THREAD_MAX = 100;
export const getThread = async (connId: string, localIssueId: string) => (await kvs.get<string[]>(K.thread(connId, localIssueId))) ?? [];
export async function appendToThread(connId: string, localIssueId: string, localCommentId: string) {
  const t = (await getThread(connId, localIssueId)).filter((id) => id !== localCommentId);
  await kvs.set(K.thread(connId, localIssueId), [...t, localCommentId].slice(-THREAD_MAX));
}
export async function removeFromThread(connId: string, localIssueId: string, localCommentId: string) {
  const t = await getThread(connId, localIssueId);
  if (t.includes(localCommentId)) await kvs.set(K.thread(connId, localIssueId), t.filter((id) => id !== localCommentId));
}

// ---- site settings

/** How this site introduces itself to partners: its address, or an anonymous name. */
export interface SiteSettings {
  displayName: string;
  mode: "site" | "anonymous" | "custom";
}
export const getSettings = () => kvs.get<SiteSettings>(K.settings);
export const setSettings = (s: SiteSettings) => kvs.set(K.settings, s);
