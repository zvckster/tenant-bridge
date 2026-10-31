import { Queue } from "@forge/events";

/**
 * Background work runs on the Forge async event queue (consumer function with a long
 * timeout), never in event handlers or the relay ping, which have short limits.
 * Concurrent mailbox/tick jobs are safe: the per-connection inbox and outbox locks
 * serialize them (a busy inbox is simply left on the relay for the holder).
 */
export type Job =
  | { kind: "mailbox" }
  | { kind: "tick" }
  | { kind: "sendAttachment"; connectionId: string; localIssueId: string; attachmentId: string; ref: { owner: string; id: string; key: string } }
  | { kind: "receiveAttachment"; connectionId: string; origin: { tenant: string; id: string } };

const queue = new Queue({ key: "tb-jobs" });

export async function enqueue(job: Job): Promise<void> {
  // Note: the push `concurrency` option was rejected (HTTP 400) by Forge in live tests.
  await queue.push({ body: job as unknown as Record<string, unknown> });
}
