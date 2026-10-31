import { channelFor, type Envelope, envelopeSize, type Payload, PayloadSchema, type Policy, retransmitDelayMs, seal } from "@tb/protocol";
import { withLock } from "./lock";
import { relay } from "./relay";
import {
  deleteOutboxEntry,
  getConnectionKeys,
  getOutboxEntry,
  getOutboxMeta,
  listConnections,
  type LocalConnection,
  setOutboxEntry,
  setOutboxMeta,
} from "./state";

export const EPOCH = 0; // key rotation arrives in phase 4

/** Envelopes are stored one per KVS value until acked, so they must stay under its size limit. */
export const MAX_STORED_ENVELOPE = 200 * 1024;

export type ActiveConnection = LocalConnection & { peer: string; policy: Policy };

/** A partner operation this tenant refuses; reported back as a `rejected` payload. */
export class Rejected extends Error {}

export async function activeConnections(): Promise<ActiveConnection[]> {
  return (await listConnections()).filter(
    (c): c is ActiveConnection => c.status === "active" && !!c.policy && !!c.peer,
  );
}

/** Encrypts and sends one payload. Data payloads stay in the outbox until acknowledged. */
export async function send(conn: LocalConnection, payload: Payload): Promise<void> {
  // Catch our own bugs here, loudly, rather than as a rejection on the partner's side.
  const check = PayloadSchema.safeParse(payload);
  if (!check.success) {
    throw new Error(`refusing to send invalid ${payload.type}: ${check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const keys = await getConnectionKeys(conn.id);
  if (!keys) throw new Error(`no keys for connection ${conn.id}`);
  const ch = channelFor(payload.type);
  // Seq reservation and outbox write must be atomic across concurrent invocations.
  const env = await withLock(`outbox:${conn.id}`, async () => {
    const meta = await getOutboxMeta(conn.id);
    const seq = ch === "d" ? meta.nextSeq : meta.nextCtrlSeq;
    const sealed = seal(keys, ch, seq, EPOCH, payload);
    if (ch === "d" && envelopeSize(sealed) > MAX_STORED_ENVELOPE) {
      throw new Error(`${payload.type} is too large to queue (${envelopeSize(sealed)} bytes)`);
    }
    if (ch === "d") {
      const now = Date.now();
      await setOutboxEntry(conn.id, { env: sealed, firstSentAt: now, lastSentAt: now, attempts: 1 });
      await setOutboxMeta(conn.id, { ...meta, nextSeq: seq + 1, seqs: [...meta.seqs, seq] });
    } else {
      await setOutboxMeta(conn.id, { ...meta, nextCtrlSeq: seq + 1 });
    }
    return sealed;
  });
  const { client } = await relay();
  try {
    await client.send(env);
  } catch (err) {
    // Data envelopes are retransmitted by the tick; control ones are cumulative and will be resent.
    console.warn(`send failed on ${conn.id} seq ${env.seq}: ${String(err)}`);
  }
}

/** The partner applied everything up to `appliedUpTo`: forget those envelopes. */
export async function ackOutbox(conn: LocalConnection, appliedUpTo: number): Promise<void> {
  await withLock(`outbox:${conn.id}`, async () => {
    const meta = await getOutboxMeta(conn.id);
    const done = meta.seqs.filter((s) => s <= appliedUpTo);
    if (done.length === 0) return;
    await setOutboxMeta(conn.id, { ...meta, seqs: meta.seqs.filter((s) => s > appliedUpTo) });
    for (const seq of done) await deleteOutboxEntry(conn.id, seq);
  });
}

/** Resends overdue envelopes and those the partner reported missing, identical to the original. */
export async function retransmit(conn: LocalConnection, missing: number[] = [], now = Date.now()): Promise<void> {
  const forced = new Set(missing);
  const { client } = await relay();
  const meta = await getOutboxMeta(conn.id);
  const sent: Envelope[] = [];
  for (const seq of meta.seqs) {
    const e = await getOutboxEntry(conn.id, seq);
    if (!e || !(forced.has(seq) || now - e.lastSentAt >= retransmitDelayMs(e.attempts))) continue;
    try {
      await client.send(e.env);
      sent.push(e.env);
    } catch (err) {
      console.warn(`retransmit failed on ${conn.id} seq ${seq}: ${String(err)}`);
      break;
    }
  }
  if (sent.length === 0) return;
  await withLock(`outbox:${conn.id}`, async () => {
    for (const env of sent) {
      const e = await getOutboxEntry(conn.id, env.seq); // gone if acked meanwhile
      if (e) await setOutboxEntry(conn.id, { ...e, lastSentAt: Date.now(), attempts: e.attempts + 1 });
    }
  });
}
