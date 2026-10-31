import { invoke as bridgeInvoke } from "@forge/bridge";

// Without metadata, invoke resolves to the resolver's return value.
export const call = <T = unknown,>(key: string, payload?: Record<string, unknown>) => bridgeInvoke(key, payload) as Promise<T>;

/** Resolver errors arrive as "There was an error invoking the function - <message>". */
export function errorText(e: unknown): string {
  const msg = String((e as Error)?.message ?? e);
  return msg.replace(/^.*error invoking the function\s*-\s*/i, "");
}

export interface Usage {
  sentBytes: number;
  sentMessages: number;
  receivedBytes: number;
  receivedMessages: number;
}

export type PolicyDraft = {
  outbound: {
    spaces: string[];
    issueTypes: string[];
    labels: string[];
    jql?: string;
    fields: string[];
    customFields: string[];
    comments: "off" | "public";
    attachments: { enabled: boolean; maxBytes: number; mimeTypes: string[] };
    people: "name" | "anonymous";
    orgLabel: string;
  };
  partner: {
    commentCreate: boolean;
    commentEditOwn: boolean;
    commentDeleteOwn: boolean;
    reactionSet: boolean;
    statusTransitions: Array<{ from?: string; to: string }>;
    editableFields: string[];
    attachmentAdd: { enabled: boolean; maxBytes: number; mimeTypes: string[] };
    ticketCreate: boolean;
  };
  inbound: {
    targetSpace: string;
    issueType: string;
    statusMap: Record<string, string>;
    attachments: { enabled: boolean; maxBytes: number; mimeTypes: string[] };
  };
};

export interface Connection {
  id: string;
  role: "inviter" | "acceptor";
  status: "awaiting_partner" | "pending_approval" | "awaiting_confirm" | "active" | "revoked";
  peerBundle?: { siteName: string };
  peerFingerprint?: string;
  policy?: PolicyDraft;
  createdAt: number;
  usage: Usage | null;
}

export interface Overview {
  site: string;
  settings: { displayName: string; mode: "site" | "anonymous" | "custom" };
  myFingerprint: string;
  connections: Connection[];
}

export interface Space {
  key: string;
  name: string;
  issueTypes: string[];
}

export const MB = 1024 * 1024;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * MB) return `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`;
  return `${(n / 1024 / MB).toFixed(1)} GB`;
}

/** File kinds offered in the rules editor, mapped to the MIME types the app checks. */
export const FILE_KINDS: Array<{ label: string; value: string; mimes: string[] }> = [
  { label: "Images", value: "images", mimes: ["image/png", "image/jpeg", "image/gif", "image/webp"] },
  { label: "PDF", value: "pdf", mimes: ["application/pdf"] },
  {
    label: "Office documents",
    value: "office",
    mimes: [
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
  },
  { label: "Text & CSV", value: "text", mimes: ["text/plain", "text/csv"] },
  { label: "Archives (zip)", value: "archives", mimes: ["application/zip", "application/x-zip-compressed", "application/x-7z-compressed"] },
  { label: "Video", value: "video", mimes: ["video/mp4", "video/quicktime"] },
];

export const kindsFromMimes = (mimes: string[]) =>
  FILE_KINDS.filter((k) => k.mimes.some((m) => mimes.includes(m))).map((k) => k.value);
export const mimesFromKinds = (kinds: string[]) => FILE_KINDS.filter((k) => kinds.includes(k.value)).flatMap((k) => k.mimes);

export const SIZE_OPTIONS = [5, 25, 50, 100].map((n) => ({ label: `${n} MB`, value: n * MB }));

export function defaultPolicy(orgLabel: string, spaces: Space[]): PolicyDraft {
  const first = spaces[0];
  const files = { enabled: false, maxBytes: 25 * MB, mimeTypes: mimesFromKinds(["images", "pdf"]) };
  return {
    outbound: {
      spaces: first ? [first.key] : [],
      issueTypes: [],
      labels: [],
      fields: ["description", "priority"],
      customFields: [],
      comments: "public",
      attachments: files,
      people: "name",
      orgLabel,
    },
    partner: {
      commentCreate: true,
      commentEditOwn: true,
      commentDeleteOwn: true,
      reactionSet: true,
      statusTransitions: [],
      editableFields: [],
      attachmentAdd: files,
      ticketCreate: false,
    },
    inbound: { targetSpace: first?.key ?? "", issueType: first?.issueTypes[0] ?? "Task", statusMap: {}, attachments: files },
  };
}
