import { sha256 } from "@noble/hashes/sha2.js";
import { z } from "zod";
import { canon, toB64u } from "./encoding.js";

/** A ticket is always identified by the tenant that owns it plus its id there. */
export const TicketRefSchema = z.object({
  owner: z.uuid(), // installId of the owning tenant
  id: z.string().min(1), // Jira issue id on the owner side
  key: z.string().min(1), // e.g. SUP-12, for display only
});
export type TicketRef = z.infer<typeof TicketRefSchema>;

/** Who created a comment/attachment: always recorded, used for "edit own" checks. */
export const OriginSchema = z.object({
  tenant: z.uuid(),
  id: z.string().min(1),
});
export type Origin = z.infer<typeof OriginSchema>;

const opId = z.uuid();
const adf = z.unknown(); // Atlassian Document Format; validated by Jira on write

export const SnapshotFieldsSchema = z.object({
  summary: z.string(),
  status: z.object({ name: z.string(), category: z.string() }),
  issueType: z.string(),
  description: adf.optional(),
  priority: z.string().optional(),
  labels: z.array(z.string()).optional(),
  dueDate: z.string().optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
});
export type SnapshotFields = z.infer<typeof SnapshotFieldsSchema>;

export const PayloadSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ticket.snapshot"),
    opId,
    ref: TicketRefSchema,
    fields: SnapshotFieldsSchema,
    updatedAt: z.string(),
  }),
  z.object({
    type: z.literal("comment.upsert"),
    opId,
    ticket: TicketRefSchema,
    origin: OriginSchema,
    author: z.string(),
    body: adf,
    updatedAt: z.string(),
  }),
  z.object({ type: z.literal("comment.delete"), opId, ticket: TicketRefSchema, origin: OriginSchema }),
  z.object({
    type: z.literal("reaction.set"),
    opId,
    ticket: TicketRefSchema,
    comment: OriginSchema,
    emoji: z.string().max(64),
    on: z.boolean(),
  }),
  z.object({ type: z.literal("status.request"), opId, ticket: TicketRefSchema, to: z.string() }),
  z.object({
    type: z.literal("field.request"),
    opId,
    ticket: TicketRefSchema,
    field: z.string(),
    value: z.unknown(),
  }),
  z.object({
    type: z.literal("ticket.create.request"),
    opId,
    origin: OriginSchema,
    fields: SnapshotFieldsSchema.pick({ summary: true, description: true, priority: true }),
  }),
  z.object({
    type: z.literal("attachment.offer"),
    opId,
    ticket: TicketRefSchema,
    origin: OriginSchema,
    filename: z.string().max(255),
    mimeType: z.string(),
    size: z.number().int().nonnegative(),
    sha256: z.string(),
    chunks: z.number().int().positive(),
    /** The encrypted file on the relay, and the key to open it. Present in current senders. */
    blob: z.object({ id: z.uuid(), key: z.string().min(1) }).optional(),
  }),
  z.object({
    type: z.literal("attachment.chunk"),
    opId,
    origin: OriginSchema,
    index: z.number().int().nonnegative(),
    data: z.string(), // base64url
    sha256: z.string(),
  }),
  z.object({
    type: z.literal("ack"),
    appliedUpTo: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("nack"), missing: z.array(z.number().int().positive()).max(1000) }),
  z.object({
    type: z.literal("rejected"),
    seq: z.number().int().positive(),
    opId: z.uuid().optional(),
    reason: z.string(),
  }),
  z.object({
    type: z.literal("manifest"),
    items: z.array(z.object({ ref: TicketRefSchema, hash: z.string() })).max(5000),
  }),
  z.object({ type: z.literal("resync.request"), refs: z.array(TicketRefSchema).max(500) }),
  z.object({ type: z.literal("policy.summary"), capabilities: z.record(z.string(), z.unknown()) }),
]);
export type Payload = z.infer<typeof PayloadSchema>;
export type PayloadOf<T extends Payload["type"]> = Extract<Payload, { type: T }>;

/** Payloads carried on the control channel ("c"). Everything else must use "d". */
export const CONTROL_CHANNEL_TYPES = new Set<Payload["type"]>(["ack", "nack"]);

export function channelFor(type: Payload["type"]): "c" | "d" {
  return CONTROL_CHANNEL_TYPES.has(type) ? "c" : "d";
}

/**
 * Raw bytes per attachment.chunk. Small enough that a sealed chunk envelope fits in one
 * Forge KVS value (~240 KiB) while queued: 96 KiB → ~128 KiB base64 → ~175 KiB sealed.
 */
export const ATTACHMENT_CHUNK_BYTES = 96 * 1024;

/** Upper bound for any single attachment, whatever the policies say. */
export const ATTACHMENT_HARD_LIMIT = 100 * 1024 * 1024;

/** SHA-256 as base64url, used for attachment chunk and file integrity. */
export function digest(bytes: Uint8Array): string {
  return toB64u(sha256(bytes));
}

/** Hash of the shared view of a ticket, compared during reconciliation. */
export function snapshotHash(s: PayloadOf<"ticket.snapshot">): string {
  return toB64u(sha256(canon({ ref: s.ref, fields: s.fields })));
}
