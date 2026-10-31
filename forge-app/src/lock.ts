import { kvs } from "@forge/kvs";

export class LockBusyError extends Error {}

const LOCK_TTL_MS = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface LockValue {
  owner: string;
  expiresAt: number;
}

/**
 * Short mutual exclusion across concurrent Forge invocations, built on a FAIL_IF_EXISTS
 * write. The expiry lives in the value: KVS TTLs are not removed promptly, so a holder
 * that timed out must not block others beyond LOCK_TTL_MS. Use one lock per mutable
 * record (e.g. an outbox); never nest the same key.
 */
export async function withLock<T>(name: string, fn: () => Promise<T>, waitMs = 8000): Promise<T> {
  const key = `lock:${name}`;
  const owner = crypto.randomUUID();
  const deadline = Date.now() + waitMs;
  for (let attempt = 0; ; attempt++) {
    try {
      const value: LockValue = { owner, expiresAt: Date.now() + LOCK_TTL_MS };
      await kvs.set(key, value, { keyPolicy: "FAIL_IF_EXISTS", ttl: { value: 2 * LOCK_TTL_MS / 1000, unit: "SECONDS" } });
      break;
    } catch (err) {
      const held = await kvs.get<LockValue>(key);
      if (held === undefined) {
        if (attempt > 2) throw err; // not a conflict: a real storage error
        continue;
      }
      if (held.expiresAt < Date.now()) {
        // Stale lock from an invocation that died: take it over.
        await kvs.delete(key);
        continue;
      }
      if (Date.now() >= deadline) throw new LockBusyError(`lock ${name} busy`);
      await sleep(Math.min(100 * 2 ** attempt, 1000));
    }
  }
  try {
    return await fn();
  } finally {
    if ((await kvs.get<LockValue>(key))?.owner === owner) await kvs.delete(key);
  }
}
