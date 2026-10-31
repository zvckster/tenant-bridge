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

/** Only comments that arrive this much later than written show their original time. */
export const SHOW_TIME_AFTER_MS = 2 * 60 * 1000;

const GREY = { type: "textColor", attrs: { color: "#6b778c" } };

export interface Attribution {
  /** As sent by the partner, e.g. "Ayman · Zvcks"; only the person's name is shown. */
  author: string;
  createdAt?: string;
  /** Set when this reply crossed another comment in transit: what it actually answers. */
  crossed?: { snippet?: string };
  now?: number;
}

/** The person's name from a partner label ("Ayman · Zvcks" → "Ayman"; "Zvcks team" stays). */
export const displayName = (label: string) => label.split(" · ")[0]!.trim();

/**
 * Keeps synced comments close to a native one: "**Ayman** text", since the app posts
 * them as itself. A small grey note is added only when it matters: the original time
 * if the comment arrived late, and "↩ Re: …" if it crossed newer comments in transit.
 */
export function withAttribution(a: Attribution, body: unknown): unknown {
  const doc = (body as Node | undefined) ?? { type: "doc", version: 1, content: [] };
  const content = [...(doc.content ?? [])];
  const lead: Node[] = [{ type: "text", text: displayName(a.author), marks: [{ type: "strong" }] }, { type: "text", text: " " }];
  if (content[0]?.type === "paragraph") {
    content[0] = { ...content[0], content: [...lead, ...(content[0].content ?? [])] };
  } else {
    content.unshift({ type: "paragraph", content: lead });
  }

  const written = a.createdAt ? Date.parse(a.createdAt) : NaN;
  if (!Number.isNaN(written) && (a.now ?? Date.now()) - written > SHOW_TIME_AFTER_MS) {
    const last = content[content.length - 1]!;
    const note: Node = { type: "text", text: ` · sent ${formatTime(a.createdAt)}`, marks: [GREY] };
    if (last.type === "paragraph") content[content.length - 1] = { ...last, content: [...(last.content ?? []), note] };
    else content.push({ type: "paragraph", content: [note] });
  }

  if (a.crossed) {
    const text = a.crossed.snippet ? `↩ Re: “${a.crossed.snippet}”` : "↩ Written before the comments above";
    content.unshift({ type: "paragraph", content: [{ type: "text", text, marks: [{ type: "em" }, GREY] }] });
  }
  return { ...doc, type: "doc", version: 1, content };
}

/**
 * The words of a comment for a "↩ Re:" quote, without our own notes: drops the grey
 * lines (crossing note, sent time) and the bold author lead of a synced comment.
 */
export function quoteOf(body: unknown, max = 60): { snippet: string } {
  const doc = body as Node | undefined;
  const isGrey = (n: Node) => Array.isArray(n.marks) && (n.marks as Array<{ type: string }>).some((m) => m.type === "textColor");
  const paras = (doc?.content ?? []).filter((p) => !(p.content ?? []).every(isGrey));
  const first = paras[0];
  if (first?.content?.[0] && Array.isArray(first.content[0].marks) && (first.content[0].marks as Array<{ type: string }>).some((m) => m.type === "strong")) {
    paras[0] = { ...first, content: first.content.slice(1) };
  }
  const text = plainText({ type: "doc", content: paras.map((p) => ({ ...p, content: (p.content ?? []).filter((n) => !isGrey(n)) })) }, 1000);
  return { snippet: text.length > max ? `${text.slice(0, max - 1)}…` : text };
}
