/** Helpers for Atlassian Document Format bodies crossing tenants. */

type Node = { type: string; content?: Node[]; attrs?: Record<string, unknown>; [k: string]: unknown };

/**
 * Media nodes point at files that exist only on the source tenant (Jira's REST API gives
 * no way to embed a freshly uploaded attachment by media id), so inline images become a
 * named reference to the synced attachment.
 * Mentions are reduced to plain text so no accountId crosses over.
 */
export function sanitizeAdf(doc: unknown): unknown {
  if (!doc || typeof doc !== "object") return doc;
  const walk = (n: Node): Node | null => {
    if (n.type === "media" || n.type === "mediaInline") {
      // The file itself travels as an attachment (if both sides allow it); keep a readable pointer.
      const name = typeof n.attrs?.alt === "string" && n.attrs.alt ? n.attrs.alt : "file";
      return { type: "text", text: `[${name} — see attachments]`, marks: [{ type: "em" }] };
    }
    if (n.type === "mediaSingle" || n.type === "mediaGroup") {
      const inner = (n.content ?? []).map(walk).filter((x): x is Node => !!x);
      return { type: "paragraph", content: inner };
    }
    if (n.type === "mention") return { type: "text", text: String(n.attrs?.text ?? "@someone") };
    const out: Node = { ...n };
    if (n.content) out.content = n.content.map(walk).filter((x): x is Node => !!x);
    return out;
  };
  return walk(doc as Node);
}

/** Plain text of an ADF document, shortened to `max` characters. */
export function plainText(doc: unknown, max = 80): string {
  const parts: string[] = [];
  const walk = (n: Node | undefined) => {
    if (!n) return;
    if (typeof n.text === "string") parts.push(n.text);
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc as Node);
  const text = parts.join(" ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** "31 Oct, 10:42 UTC": the author's original time, since Jira can't backdate comments. */
export function formatTime(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const month = d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${month}, ${hh}:${mm} UTC`;
}

export interface Attribution {
  author: string; // e.g. "Ayman · Zvcks"
  createdAt?: string;
  /** Set when this reply crossed another comment in transit. */
  crossed?: { snippet?: string };
}

/**
 * Puts the partner's author and original time at the start of the comment's first line
 * ("**Ayman · Zvcks** · 31 Oct, 10:42 UTC — text…"), since the app posts it as itself.
 * A reply that crossed newer comments in transit gets a "↪ reply to …" line on top.
 */
export function withAttribution(a: Attribution, body: unknown): unknown {
  const doc = (body as Node | undefined) ?? { type: "doc", version: 1, content: [] };
  const content = [...(doc.content ?? [])];
  const time = formatTime(a.createdAt);
  const lead: Node[] = [
    { type: "text", text: a.author, marks: [{ type: "strong" }] },
    { type: "text", text: `${time ? ` · ${time}` : ""} — ` },
  ];
  if (content[0]?.type === "paragraph") {
    content[0] = { ...content[0], content: [...lead, ...(content[0].content ?? [])] };
  } else {
    content.unshift({ type: "paragraph", content: lead });
  }
  if (a.crossed) {
    const text = a.crossed.snippet ? `↪ reply to “${a.crossed.snippet}”` : "↪ written before the comments above";
    content.unshift({ type: "paragraph", content: [{ type: "text", text, marks: [{ type: "em" }] }] });
  }
  return { ...doc, type: "doc", version: 1, content };
}
