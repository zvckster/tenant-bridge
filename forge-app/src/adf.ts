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

/** Prefixes a partner comment with who wrote it, since the app posts it as itself. */
export function withAuthor(label: string, body: unknown): unknown {
  const doc = (body as Node | undefined) ?? { type: "doc", version: 1, content: [] };
  return {
    ...doc,
    type: "doc",
    version: 1,
    content: [
      { type: "paragraph", content: [{ type: "text", text: label, marks: [{ type: "strong" }] }] },
      ...(doc.content ?? []),
    ],
  };
}
