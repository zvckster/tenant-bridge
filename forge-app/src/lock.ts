import { kvs } from "@forge/kvs";

export class LockBusyError extends Error {}

const LOCK_TTL_SECONDS = 60;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Short mutual exclusion across concurrent Forge invocations (event, tick, relay ping),
 * built on a FAIL_IF_EXISTS write with a TTL so a crashed holder cannot block forever.
 * Use one lock per mutable record (e.g. an outbox); never nest the same key.
 */
export async function withLock<T>(name: string, fn: () => Promise<T>, waitMs = 8000): Promise<T> {
  const key = `lock:${name}`;
  const owner = crypto.randomUUID();
  const deadline = Date.now() + waitMs;
  for (let attempt = 0; ; attempt++) {
    try {
      await kvs.set(key, owner, { keyPolicy: "FAIL_IF_EXISTS", ttl: { value: LOCK_TTL_SECONDS, unit: "SECONDS" } });
      break;
    } catch (err) {
      // Only "already exists" means busy; anything else is a real storage error.
      if ((await kvs.get(key)) === undefined) throw err;
      if (Date.now() >= deadline) throw new LockBusyError(`lock ${name} busy`);
      await sleep(Math.min(100 * 2 ** attempt, 1000));
    }
  }
  try {
    return await fn();
  } finally {
    if ((await kvs.get(key)) === owner) await kvs.delete(key);
  }
}
