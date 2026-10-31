import {
  ATTACHMENT_CHUNK_BYTES,
  ATTACHMENT_HARD_LIMIT,
  digest,
  fromB64u,
  type PayloadOf,
  type TicketRef,
  toB64u,
} from "@tb/protocol";
import * as jira from "./jira";
import {
  deleteChunk,
  deleteIncoming,
  getAttachmentOrigin,
  getChunk,
  getIncoming,
  getLocalAttachmentId,
  isAttachmentSent,
  linkAttachment,
  markAttachmentSent,
  setChunk,
  setIncoming,
} from "./state";
import { type ActiveConnection, Rejected, send } from "./transport";

/**
 * Sends the partner every attachment of one of my issues (or of my mirror of theirs)
 * that my outbound rules allow and that it doesn't have yet. Files received from the
 * partner are never sent back.
 *
 * TODO(scale): very large files may not finish within one Forge invocation; move the
 * chunk loop to an async event queue (@forge/events) that resumes from the last chunk.
 */
export async function syncAttachments(conn: ActiveConnection, localIssueId: string, ref: TicketRef, me: string): Promise<void> {
  const rules = conn.policy.outbound.attachments;
  if (!rules.enabled) return;
  for (const a of await jira.listAttachments(localIssueId)) {
    if (await getAttachmentOrigin(a.id)) continue;
    if (await isAttachmentSent(conn.id, a.id)) continue;
    if (a.size > rules.maxBytes || a.size > ATTACHMENT_HARD_LIMIT) continue;
    if (rules.mimeTypes.length > 0 && !rules.mimeTypes.includes(a.mimeType)) continue;

    const bytes = await jira.downloadAttachment(a.id);
    const origin = { tenant: me, id: a.id };
    const chunks = Math.max(1, Math.ceil(bytes.length / ATTACHMENT_CHUNK_BYTES));
    await send(conn, {
      type: "attachment.offer",
      opId: crypto.randomUUID(),
      ticket: ref,
      origin,
      filename: a.filename,
      mimeType: a.mimeType,
      size: bytes.length,
      sha256: digest(bytes),
      chunks,
    });
    for (let i = 0; i < chunks; i++) {
      const part = bytes.subarray(i * ATTACHMENT_CHUNK_BYTES, (i + 1) * ATTACHMENT_CHUNK_BYTES);
      await send(conn, { type: "attachment.chunk", opId: crypto.randomUUID(), origin, index: i, data: toB64u(part), sha256: digest(part) });
    }
    await markAttachmentSent(conn.id, a.id);
  }
}

/** An allowed offer: remember it so the chunks that follow (in order) can be collected. */
export async function acceptOffer(conn: ActiveConnection, p: PayloadOf<"attachment.offer">, localIssueId: string): Promise<void> {
  if (await getLocalAttachmentId(conn.id, p.origin)) return; // already have this file
  await setIncoming(conn.id, p.origin, {
    localIssueId,
    filename: p.filename,
    mimeType: p.mimeType,
    size: p.size,
    sha256: p.sha256,
    chunks: p.chunks,
    received: 0,
  });
}

/**
 * Stores one chunk; on the last one, verifies the whole file and uploads it to Jira.
 * Chunks for offers we refused (or already finished) are ignored, so a refusal costs
 * one `rejected` message, not one per chunk.
 */
export async function acceptChunk(conn: ActiveConnection, p: PayloadOf<"attachment.chunk">): Promise<void> {
  const inc = await getIncoming(conn.id, p.origin);
  if (!inc || p.index < inc.received) return;
  if (p.index !== inc.received) throw new Error(`attachment chunk ${p.index} arrived before ${inc.received}`);
  // The envelope is already authenticated; this also catches sender-side bugs.
  if (digest(fromB64u(p.data)) !== p.sha256) throw new Rejected("attachment_chunk_corrupt");

  await setChunk(conn.id, p.origin, p.index, p.data);
  const received = inc.received + 1;
  if (received < inc.chunks) {
    await setIncoming(conn.id, p.origin, { ...inc, received });
    return;
  }

  const parts: Uint8Array[] = [];
  for (let i = 0; i < inc.chunks; i++) {
    const data = await getChunk(conn.id, p.origin, i);
    if (data === undefined) throw new Error(`attachment chunk ${i} missing from storage`);
    parts.push(fromB64u(data));
  }
  const bytes = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let offset = 0;
  for (const x of parts) {
    bytes.set(x, offset);
    offset += x.length;
  }
  const cleanup = async () => {
    for (let i = 0; i < inc.chunks; i++) await deleteChunk(conn.id, p.origin, i);
    await deleteIncoming(conn.id, p.origin);
  };
  if (bytes.length !== inc.size || digest(bytes) !== inc.sha256) {
    await cleanup();
    throw new Rejected("attachment_corrupt");
  }
  const localId = await jira.uploadAttachment(inc.localIssueId, inc.filename, inc.mimeType, bytes);
  await linkAttachment(conn.id, p.origin, localId);
  await cleanup();
}
