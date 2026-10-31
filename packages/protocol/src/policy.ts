import { z } from "zod";
import { ATTACHMENT_HARD_LIMIT, type Payload, type PayloadOf, type SnapshotFields, type TicketRef } from "./payloads.js";

const AttachmentRules = z.object({
  enabled: z.boolean().default(false),
  maxBytes: z.number().int().positive().default(25 * 1024 * 1024),
  mimeTypes: z.array(z.string()).default(["image/png", "image/jpeg", "application/pdf"]),
});

export const OPTIONAL_FIELDS = ["description", "priority", "labels", "dueDate"] as const;
export type OptionalField = (typeof OPTIONAL_FIELDS)[number];

/** One tenant's rules for one connection. Defaults are deny-by-default. */
export const PolicySchema = z.object({
  outbound: z.object({
    spaces: z.array(z.string()).min(1), // Jira space (project) keys
    issueTypes: z.array(z.string()).default([]), // empty = all
    labels: z.array(z.string()).default([]), // share only tickets with any of these labels (empty = all)
    jql: z.string().optional(), // advanced extra filter, AND-ed with the labels
    fields: z.array(z.enum(OPTIONAL_FIELDS)).default([]),
    customFields: z.array(z.string()).default([]),
    comments: z.enum(["off", "public"]).default("public"),
    attachments: AttachmentRules.default({ enabled: false, maxBytes: 25 * 1024 * 1024, mimeTypes: [] }),
    people: z.enum(["name", "anonymous"]).default("name"),
    orgLabel: z.string().min(1),
  }),
  partner: z
    .object({
      commentCreate: z.boolean().default(true),
      commentEditOwn: z.boolean().default(true),
      commentDeleteOwn: z.boolean().default(true),
      reactionSet: z.boolean().default(true),
      statusTransitions: z.array(z.object({ from: z.string().optional(), to: z.string() })).default([]),
      editableFields: z.array(z.string()).default([]),
      attachmentAdd: AttachmentRules.default({ enabled: false, maxBytes: 25 * 1024 * 1024, mimeTypes: [] }),
      ticketCreate: z.boolean().default(false),
    })
    .default({
      commentCreate: true,
      commentEditOwn: true,
      commentDeleteOwn: true,
      reactionSet: true,
      statusTransitions: [],
      editableFields: [],
      attachmentAdd: { enabled: false, maxBytes: 25 * 1024 * 1024, mimeTypes: [] },
      ticketCreate: false,
    }),
  inbound: z.object({
    targetSpace: z.string(),
    issueType: z.string(),
    statusMap: z.record(z.string(), z.string()).default({}),
    attachments: AttachmentRules.default({ enabled: false, maxBytes: 25 * 1024 * 1024, mimeTypes: [] }),
  }),
});
export type Policy = z.infer<typeof PolicySchema>;

/** Minimal view of a local Jira issue the policy needs. */
export interface LocalIssue {
  id: string;
  key: string;
  spaceKey: string;
  issueType: string;
  securityLevel?: string | null;
  updatedAt: string;
  fields: SnapshotFields & { custom?: Record<string, unknown> };
}

export interface LocalComment {
  id: string;
  authorName: string;
  /** Jira comment visibility; any value means restricted to a role or group. */
  visibility?: { type: string; value: string } | null;
}

const jqlString = (s: string) => `"${s.replace(/["\\]/g, "\\$&")}"`;

/** The opt-in filter the caller checks against Jira: label choice AND the advanced JQL. */
export function outboundFilterJql(policy: Policy): string | undefined {
  const parts: string[] = [];
  if (policy.outbound.labels.length > 0) parts.push(`labels in (${policy.outbound.labels.map(jqlString).join(", ")})`);
  if (policy.outbound.jql?.trim()) parts.push(`(${policy.outbound.jql.trim()})`);
  return parts.length ? parts.join(" AND ") : undefined;
}

/** Static scope checks. The opt-in filter (outboundFilterJql) must be checked by the caller against Jira. */
export function inOutboundScope(policy: Policy, issue: LocalIssue): boolean {
  if (issue.securityLevel) return false;
  if (!policy.outbound.spaces.includes(issue.spaceKey)) return false;
  const types = policy.outbound.issueTypes;
  return types.length === 0 || types.includes(issue.issueType);
}

/** Only fields on the allow-list leave the tenant. */
export function shareFields(policy: Policy, issue: LocalIssue): SnapshotFields {
  const src = issue.fields;
  const out: SnapshotFields = { summary: src.summary, status: src.status, issueType: src.issueType };
  for (const f of policy.outbound.fields) {
    if (src[f] !== undefined) (out as Record<string, unknown>)[f] = src[f];
  }
  if (policy.outbound.customFields.length > 0 && src.custom) {
    const custom: Record<string, unknown> = {};
    for (const id of policy.outbound.customFields) if (id in src.custom) custom[id] = src.custom[id];
    out.custom = custom;
  }
  return out;
}

export function commentShareable(policy: Policy, c: LocalComment): boolean {
  return policy.outbound.comments === "public" && !c.visibility;
}

/** How a local person appears to the partner, e.g. "Ayman · Zvcks". Never email or accountId. */
export function authorLabel(policy: Policy, displayName: string): string {
  return policy.outbound.people === "anonymous"
    ? `${policy.outbound.orgLabel} team`
    : `${displayName} · ${policy.outbound.orgLabel}`;
}

export type Decision = { allow: true } | { allow: false; reason: string };
const allow: Decision = { allow: true };
const deny = (reason: string): Decision => ({ allow: false, reason });

/** Facts the receiving app looks up locally before deciding. */
export interface InboundContext {
  me: string; // my installId
  partner: string; // partner installId
  /** For comment ops: origin tenant of the existing comment, if we already have it. */
  existingOriginTenant?: string;
  /** For status requests: the ticket's current status name. */
  currentStatus?: string;
}

/**
 * Decides whether a partner operation may be applied to my Jira.
 * Runs on the receiving side before every write; the partner's own view is never trusted.
 */
export function authorizeInbound(policy: Policy, p: Payload, ctx: InboundContext): Decision {
  const caps = policy.partner;
  const ownedByMe = (t: TicketRef) => t.owner === ctx.me;
  const ownedByPartner = (t: TicketRef) => t.owner === ctx.partner;
  const knownTicket = (t: TicketRef) => ownedByMe(t) || ownedByPartner(t);

  switch (p.type) {
    case "ack":
    case "nack":
    case "rejected":
    case "manifest":
    case "resync.request":
    case "policy.summary":
      return allow;

    case "ticket.snapshot":
      return ownedByPartner(p.ref) ? allow : deny("snapshot_not_owner");

    case "comment.upsert":
    case "comment.delete": {
      if (!knownTicket(p.ticket)) return deny("unknown_ticket");
      if (p.origin.tenant !== ctx.partner) return deny("origin_not_partner");
      if (ctx.existingOriginTenant && ctx.existingOriginTenant !== ctx.partner) {
        return deny("not_own_comment");
      }
      // Mirror of a partner ticket: the owner speaks for its own comments.
      if (ownedByPartner(p.ticket)) return allow;
      if (p.type === "comment.delete") return caps.commentDeleteOwn ? allow : deny("capability_denied");
      if (ctx.existingOriginTenant) return caps.commentEditOwn ? allow : deny("capability_denied");
      return caps.commentCreate ? allow : deny("capability_denied");
    }

    case "reaction.set":
      if (!knownTicket(p.ticket)) return deny("unknown_ticket");
      return ownedByPartner(p.ticket) || caps.reactionSet ? allow : deny("capability_denied");

    case "status.request": {
      if (!ownedByMe(p.ticket)) return deny("not_owner");
      const ok = caps.statusTransitions.some(
        (t) => t.to === p.to && (t.from === undefined || t.from === ctx.currentStatus),
      );
      return ok ? allow : deny("transition_not_allowed");
    }

    case "field.request": {
      if (!ownedByMe(p.ticket)) return deny("not_owner");
      // A partner can never edit a field it cannot see.
      const visible =
        (policy.outbound.fields as string[]).includes(p.field) ||
        policy.outbound.customFields.includes(p.field) ||
        p.field === "summary";
      return visible && caps.editableFields.includes(p.field) ? allow : deny("field_not_editable");
    }

    case "ticket.create.request":
      if (p.origin.tenant !== ctx.partner) return deny("origin_not_partner");
      return caps.ticketCreate ? allow : deny("capability_denied");

    case "attachment.offer": {
      if (!knownTicket(p.ticket)) return deny("unknown_ticket");
      if (p.origin.tenant !== ctx.partner) return deny("origin_not_partner");
      const rules = ownedByMe(p.ticket) ? caps.attachmentAdd : policy.inbound.attachments;
      if (!rules.enabled) return deny("capability_denied");
      if (p.size > rules.maxBytes || p.size > ATTACHMENT_HARD_LIMIT) return deny("attachment_too_large");
      if (rules.mimeTypes.length > 0 && !rules.mimeTypes.includes(p.mimeType)) {
        return deny("attachment_type_not_allowed");
      }
      return allow;
    }

    case "attachment.chunk":
      // Chunks are only accepted for offers that were allowed; the caller tracks that.
      return p.origin.tenant === ctx.partner ? allow : deny("origin_not_partner");
  }
}

/** What I tell the partner they may do (for their UI only; enforcement stays here). */
export function capabilitySummary(policy: Policy): PayloadOf<"policy.summary"> {
  return { type: "policy.summary", capabilities: { ...policy.partner } };
}
