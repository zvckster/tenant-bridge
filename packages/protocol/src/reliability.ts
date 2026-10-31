import type { Envelope } from "./envelope.js";

/**
 * Receiver side of one connection direction (data channel). Pure data so it can be
 * stored as-is in Forge storage between invocations.
 */
export interface InboxState {
  appliedUpTo: number; // every data seq <= this has been applied (or rejected)
  pending: Record<number, Envelope>; // received out of order, waiting for a gap to fill
  ctrlSeen: number; // highest control seq processed; older control messages are stale
}

export const MAX_PENDING = 500;

export const emptyInbox = (): InboxState => ({ appliedUpTo: 0, pending: {}, ctrlSeen: 0 });

/**
 * Stores a received data envelope. Call takeReady() afterwards to get what can be applied.
 * `kept` is false only when the buffer is full: the caller must then NOT ack it to the
 * relay, so it can be fetched again later. Duplicates are kept=true (safe to ack) and
 * flagged, since a duplicate means the sender is missing our ack.
 */
export function receive(state: InboxState, env: Envelope): { state: InboxState; duplicate: boolean; kept: boolean } {
  if (env.ch !== "d") throw new Error("receive() is for the data channel");
  if (env.seq <= state.appliedUpTo || state.pending[env.seq]) {
    return { state, duplicate: true, kept: true };
  }
  if (Object.keys(state.pending).length >= MAX_PENDING) {
    // Too far ahead; leave it on the relay and let nack/retransmit bring it back later.
    return { state, duplicate: false, kept: false };
  }
  return { state: { ...state, pending: { ...state.pending, [env.seq]: env } }, duplicate: false, kept: true };
}

/** Removes and returns the contiguous run of envelopes after `appliedUpTo`. */
export function takeReady(state: InboxState): { state: InboxState; ready: Envelope[] } {
  const pending = { ...state.pending };
  const ready: Envelope[] = [];
  let next = state.appliedUpTo + 1;
  while (pending[next]) {
    ready.push(pending[next]!);
    delete pending[next];
    next++;
  }
  return { state: { ...state, pending }, ready };
}

/**
 * Puts envelopes from `ready` back when applying had to stop (e.g. Jira temporarily
 * unavailable), so they are retried on the next run.
 */
export function requeue(state: InboxState, envs: Envelope[]): InboxState {
  const pending = { ...state.pending };
  for (const e of envs) if (e.seq > state.appliedUpTo) pending[e.seq] = e;
  return { ...state, pending };
}

/** Call after an envelope from `ready` was applied or rejected. Must be called in order. */
export function markApplied(state: InboxState, seq: number): InboxState {
  if (seq !== state.appliedUpTo + 1) throw new Error(`out-of-order apply: ${seq}`);
  return { ...state, appliedUpTo: seq };
}

/** Sequence numbers we know are missing (between what we applied and what we hold). */
export function missingSeqs(state: InboxState, limit = 1000): number[] {
  const held = Object.keys(state.pending).map(Number);
  if (held.length === 0) return [];
  const max = Math.max(...held);
  const missing: number[] = [];
  for (let s = state.appliedUpTo + 1; s < max && missing.length < limit; s++) {
    if (!state.pending[s]) missing.push(s);
  }
  return missing;
}

/** Control channel: accept only messages newer than the last one processed. */
export function receiveControl(state: InboxState, env: Envelope): { state: InboxState; fresh: boolean } {
  if (env.ch !== "c") throw new Error("receiveControl() is for the control channel");
  if (env.seq <= state.ctrlSeen) return { state, fresh: false };
  return { state: { ...state, ctrlSeen: env.seq }, fresh: true };
}

/** Sender side: data envelopes kept until the partner confirms they were applied. */
export interface OutboxEntry {
  env: Envelope;
  firstSentAt: number;
  lastSentAt: number;
  attempts: number;
}

export interface OutboxState {
  nextSeq: number; // data channel
  nextCtrlSeq: number; // control channel
  entries: Record<number, OutboxEntry>; // data only; control is never stored
}

export const emptyOutbox = (): OutboxState => ({ nextSeq: 1, nextCtrlSeq: 1, entries: {} });

export function reserveSeq(state: OutboxState, ch: "d" | "c" = "d"): { state: OutboxState; seq: number } {
  return ch === "d"
    ? { state: { ...state, nextSeq: state.nextSeq + 1 }, seq: state.nextSeq }
    : { state: { ...state, nextCtrlSeq: state.nextCtrlSeq + 1 }, seq: state.nextCtrlSeq };
}

export function recordSent(state: OutboxState, env: Envelope, now: number): OutboxState {
  if (env.ch !== "d") return state;
  const prev = state.entries[env.seq];
  const entry: OutboxEntry = prev
    ? { ...prev, lastSentAt: now, attempts: prev.attempts + 1 }
    : { env, firstSentAt: now, lastSentAt: now, attempts: 1 };
  return { ...state, entries: { ...state.entries, [env.seq]: entry } };
}

/** Partner says everything up to `appliedUpTo` is done: forget those envelopes. */
export function onAck(state: OutboxState, appliedUpTo: number): OutboxState {
  const entries: Record<number, OutboxEntry> = {};
  for (const [seq, e] of Object.entries(state.entries)) {
    if (Number(seq) > appliedUpTo) entries[Number(seq)] = e;
  }
  return { ...state, entries };
}

/** Exponential backoff: 1 min, 2, 4 ... capped at 1 h. */
export function retransmitDelayMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 3_600_000);
}

/**
 * Envelopes to send again: those the partner reported missing, plus any whose ack is overdue.
 * Retransmits reuse the identical envelope, so every hop can deduplicate on seq.
 */
export function dueForRetransmit(state: OutboxState, now: number, missing: number[] = []): Envelope[] {
  const forced = new Set(missing);
  return Object.values(state.entries)
    .filter((e) => forced.has(e.env.seq) || now - e.lastSentAt >= retransmitDelayMs(e.attempts))
    .sort((a, b) => a.env.seq - b.env.seq)
    .map((e) => e.env);
}
