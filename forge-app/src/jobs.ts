import { Queue } from "@forge/events";

/**
 * Background work runs on the Forge async event queue (consumer function with a long
 * timeout), never in event handlers or the relay ping, which have short limits.
 */
export type Job =
  | { kind: "mailbox" }
  | { kind: "tick" }
  | { kind: "sendAttachment"; connectionId: string; localIssueId: string; attachmentId: string; ref: { owner: string; id: string; key: string } }
  | { kind: "receiveAttachment"; connectionId: string; origin: { tenant: string; id: string } };

const queue = new Queue({ key: "tb-jobs" });

/** Only one mailbox/tick job per installation at a time: they share the inbox. */
const SERIAL = { key: "tb-serial", limit: 1 };
/** File transfers run beside them, a couple at a time. */
const FILES = { key: "tb-files", limit: 2 };

export async function enqueue(job: Job): Promise<void> {
  const concurrency = job.kind === "mailbox" || job.kind === "tick" ? SERIAL : FILES;
  await queue.push({ body: job as unknown as Record<string, unknown>, concurrency });
}
