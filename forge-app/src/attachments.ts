import { ATTACHMENT_HARD_LIMIT, digest, openBlob, type PayloadOf, sealBlob, type TicketRef } from "@tb/protocol";
import * as jira from "./jira";
import { enqueue } from "./jobs";
import { relay } from "./relay";
import {
  deleteIncoming,
  getAttachmentOrigin,
  getConnection,
  getIncoming,
  getLocalAttachmentId,
  getSendState,
  linkAttachment,
  setIncoming,
  setSendState,
} from "./state";
import { type ActiveConnection, Rejected, send } from "./transport";

/** A queued send that hasn't finished in this long is assumed lost and queued again. */
const SEND_RETRY_AFTER_MS = 60 * 60 * 1000;

/**
 * Queues every attachment of an issue that my outbound rules allow and that the
 * partner doesn't have yet. Cheap: the transfer itself runs in a background job.
 * Files received from the partner are never sent back.
 */
export async function syncAttachments(conn: ActiveConnection, localIssueId: string, ref: TicketRef, _me: string): Promise<void> {
  const rules = conn.policy.outbound.attachments;
  if (!rules.enabled) return;
  for (const a of await jira.listAttachments(localIssueId)) {
    if (await getAttachmentOrigin(a.id)) continue;
    const sent = await getSendState(conn.id, a.id);
    if (sent?.state === "done" || (sent?.state === "sending" && Date.now() - sent.at < SEND_RETRY_AFTER_MS)) continue;
    if (a.size > rules.maxBytes || a.size > ATTACHMENT_HARD_LIMIT) continue;
    if (rules.mimeTypes.length > 0 && !rules.mimeTypes.includes(a.mimeType)) continue;
    // Mark only once queued: a failed push must not block the file for an hour.
    await enqueue({ kind: "sendAttachment", connectionId: conn.id, localIssueId, attachmentId: a.id, ref });
    await setSendState(conn.id, a.id, { state: "sending", at: Date.now() });
  }
}

/** Job: download from Jira, encrypt, upload to the relay, then offer it to the partner. */
export async function runSendAttachment(job: { connectionId: string; localIssueId: string; attachmentId: string; ref: TicketRef }) {
  const conn = await getConnection(job.connectionId);
  if (!conn || conn.status !== "active") return;
  const { client, identity } = await relay();
  const meta = (await jira.listAttachments(job.localIssueId)).find((a) => a.id === job.attachmentId);
  if (!meta) return; // deleted meanwhile
  const bytes = await jira.downloadAttachment(job.attachmentId);
  const blobId = crypto.randomUUID();
  const sealed = sealBlob(conn.id, blobId, bytes);
  await client.putBlob(conn.id, blobId, sealed.data);
  await send(conn, {
    type: "attachment.offer",
    opId: crypto.randomUUID(),
    ticket: job.ref,
    origin: { tenant: identity.installId, id: job.attachmentId },
    filename: meta.filename,
    mimeType: meta.mimeType,
    size: bytes.length,
    sha256: digest(bytes),
    chunks: 1,
    blob: { id: blobId, key: sealed.key },
  });
  await setSendState(conn.id, job.attachmentId, { state: "done", at: Date.now() });
}

/** An allowed offer: remember it and queue the download. */
export async function acceptOffer(conn: ActiveConnection, p: PayloadOf<"attachment.offer">, localIssueId: string): Promise<void> {
  if (await getLocalAttachmentId(conn.id, p.origin)) {
    // Already have this file (a resend): just free the relay copy.
    if (p.blob) await (await relay()).client.deleteBlob(conn.id, p.blob.id).catch(() => {});
    return;
  }
  if (!p.blob) throw new Rejected("attachment_format_unsupported"); // old chunked senders
  await setIncoming(conn.id, p.origin, {
    localIssueId,
    filename: p.filename,
    mimeType: p.mimeType,
    size: p.size,
    sha256: p.sha256,
    blobId: p.blob.id,
    blobKey: p.blob.key,
  });
  await enqueue({ kind: "receiveAttachment", connectionId: conn.id, origin: p.origin });
}

/** Job: fetch the blob, decrypt, verify size and hash, upload to Jira, then free the relay copy. */
export async function runReceiveAttachment(job: { connectionId: string; origin: { tenant: string; id: string } }) {
  const inc = await getIncoming(job.connectionId, job.origin);
  if (!inc) return; // done already
  const { client } = await relay();
  if (!(await getLocalAttachmentId(job.connectionId, job.origin))) {
    const data = await client.getBlob(job.connectionId, inc.blobId);
    const bytes = openBlob(job.connectionId, inc.blobId, inc.blobKey, data);
    if (bytes.length !== inc.size || digest(bytes) !== inc.sha256) {
      // Cannot happen without a sender bug (the blob is authenticated); don't retry forever.
      console.warn(`attachment ${inc.filename} failed verification; dropped`);
      await deleteIncoming(job.connectionId, job.origin);
      return;
    }
    const localId = await jira.uploadAttachment(inc.localIssueId, inc.filename, inc.mimeType, bytes);
    await linkAttachment(job.connectionId, job.origin, localId);
  }
  await client.deleteBlob(job.connectionId, inc.blobId);
  await deleteIncoming(job.connectionId, job.origin);
}
