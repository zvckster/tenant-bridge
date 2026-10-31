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

/** "31 Oct, 10:42 UTC". */
export function formatTime(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const month = d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${month}, ${hh}:${mm} UTC`;
}

const GREY = { type: "textColor", attrs: { color: "#6b778c" } };

export interface Attribution {
  /** As sent by the partner, e.g. "Ayman · Zvcks" (or "Zvcks team" when anonymous). */
  author: string;
  createdAt?: string;
  /** Set when this reply crossed another comment in transit: what it actually answers. */
  crossed?: { snippet?: string };
}

/**
 * Lays a synced comment out like a message, since the app posts it as itself:
 *
 *   **Ayman · Zvcks**
 *   ↩ Re: “…”            (grey, only if it crossed newer comments in transit)
 *   the comment text
 *   31 Oct, 15:34 UTC     (grey: when the author wrote it)
 */
export function withAttribution(a: Attribution, body: unknown): unknown {
  const doc = (body as Node | undefined) ?? { type: "doc", version: 1, content: [] };
  const content: Node[] = [{ type: "paragraph", content: [{ type: "text", text: a.author, marks: [{ type: "strong" }] }] }];
  if (a.crossed) {
    const text = a.crossed.snippet ? `↩ Re: “${a.crossed.snippet}”` : "↩ Written before the comments above";
    content.push({ type: "paragraph", content: [{ type: "text", text, marks: [{ type: "em" }, GREY] }] });
  }
  content.push(...(doc.content ?? []));
  const time = formatTime(a.createdAt);
  if (time) content.push({ type: "paragraph", content: [{ type: "text", text: time, marks: [GREY] }] });
  return { ...doc, type: "doc", version: 1, content };
}

const marked = (n: Node, type: string) => Array.isArray(n.marks) && (n.marks as Array<{ type: string }>).some((m) => m.type === type);

/** The words of a comment for a "↩ Re:" quote, without our header and grey notes. */
export function quoteOf(body: unknown, max = 60): { snippet: string } {
  const paras = ((body as Node | undefined)?.content ?? []).filter((p) => {
    const nodes = p.content ?? [];
    if (nodes.length === 0) return false;
    if (nodes.every((n) => marked(n, "textColor"))) return false; // our grey notes
    if (nodes.length === 1 && marked(nodes[0]!, "strong") && p === (body as Node).content![0]) return false; // our header
    return true;
  });
  const text = plainText({ type: "doc", content: paras }, 1000);
  return { snippet: text.length > max ? `${text.slice(0, max - 1)}…` : text };
}
