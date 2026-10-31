import api, { route } from "@forge/api";
import type { LocalComment, LocalIssue } from "@tb/protocol";

/** All Jira calls run as the app; its access is bounded by the manifest scopes. */
async function jira<T>(r: ReturnType<typeof route>, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await api.asApp().requestJira(r, {
    method: init?.method ?? "GET",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Jira ${res.status} on ${init?.method ?? "GET"}: ${text}`);
  // Several Jira writes (issue properties, transitions, updates) answer with an empty body.
  return (text ? JSON.parse(text) : undefined) as T;
}

const BASE_FIELDS = ["summary", "status", "issuetype", "description", "priority", "labels", "duedate", "project", "security", "updated"];

interface RawIssue {
  id: string;
  key: string;
  fields: Record<string, any>;
}

export async function getIssue(issueId: string, customFields: string[] = []): Promise<LocalIssue> {
  const fields = [...BASE_FIELDS, ...customFields].join(",");
  const raw = await jira<RawIssue>(route`/rest/api/3/issue/${issueId}?fields=${fields}`);
  const f = raw.fields;
  const custom: Record<string, unknown> = {};
  for (const id of customFields) if (f[id] !== undefined) custom[id] = f[id];
  return {
    id: raw.id,
    key: raw.key,
    spaceKey: f.project?.key,
    issueType: f.issuetype?.name,
    securityLevel: f.security?.name ?? null,
    updatedAt: f.updated,
    fields: {
      summary: f.summary ?? "",
      status: { name: f.status?.name ?? "", category: f.status?.statusCategory?.key ?? "" },
      issueType: f.issuetype?.name ?? "",
      description: f.description ?? undefined,
      priority: f.priority?.name ?? undefined,
      labels: f.labels ?? undefined,
      dueDate: f.duedate ?? undefined,
      custom,
    },
  };
}

/** True if the issue also matches the admin's opt-in JQL filter. */
export async function matchesJql(issueKey: string, jql: string | undefined): Promise<boolean> {
  if (!jql) return true;
  const res = await jira<{ issues: unknown[] }>(route`/rest/api/3/search/jql`, {
    method: "POST",
    body: { jql: `key = "${issueKey}" AND (${jql})`, maxResults: 1, fields: ["id"] },
  });
  return res.issues.length > 0;
}

/** Ids of issues matching `jql`, following nextPageToken up to `max`. */
export async function searchIds(jql: string, max = 500): Promise<string[]> {
  const ids: string[] = [];
  let nextPageToken: string | undefined;
  do {
    const page = await jira<{ issues: Array<{ id: string }>; nextPageToken?: string }>(route`/rest/api/3/search/jql`, {
      method: "POST",
      body: { jql, maxResults: Math.min(100, max - ids.length), fields: ["id"], nextPageToken },
    });
    ids.push(...page.issues.map((i) => i.id));
    nextPageToken = page.nextPageToken;
  } while (nextPageToken && ids.length < max);
  return ids;
}

const jqlString = (s: string) => `"${s.replace(/["\\]/g, "\\$&")}"`;

/** JQL for everything a policy shares, optionally only issues updated in the last N minutes. */
export function scopeJql(scope: { spaces: string[]; issueTypes: string[]; jql?: string }, updatedWithinMinutes?: number): string {
  const parts = [`project in (${scope.spaces.map(jqlString).join(", ")})`];
  if (scope.issueTypes.length > 0) parts.push(`issuetype in (${scope.issueTypes.map(jqlString).join(", ")})`);
  if (scope.jql) parts.push(`(${scope.jql})`);
  if (updatedWithinMinutes !== undefined) parts.push(`updated >= "-${Math.ceil(updatedWithinMinutes)}m"`);
  return parts.join(" AND ");
}

export async function getComment(
  issueId: string,
  commentId: string,
): Promise<LocalComment & { body: unknown; created: string; updated: string }> {
  const c = await jira<any>(route`/rest/api/3/issue/${issueId}/comment/${commentId}`);
  return {
    id: c.id,
    authorName: c.author?.displayName ?? "Unknown",
    visibility: c.visibility ?? null,
    body: c.body,
    created: c.created,
    updated: c.updated,
  };
}

/** The most recent comments on an issue, oldest first. */
export async function listComments(issueId: string, max = 50): Promise<Array<{ id: string; created: string; body: unknown }>> {
  const res = await jira<{ comments: Array<{ id: string; created: string; body: unknown }> }>(
    route`/rest/api/3/issue/${issueId}/comment?orderBy=-created&maxResults=${max}`,
  );
  return res.comments.map((c) => ({ id: String(c.id), created: c.created, body: c.body })).reverse();
}

export async function createIssue(spaceKey: string, issueType: string, fields: Record<string, unknown>): Promise<string> {
  const res = await jira<{ id: string }>(route`/rest/api/3/issue`, {
    method: "POST",
    body: { fields: { project: { key: spaceKey }, issuetype: { name: issueType }, ...fields } },
  });
  return res.id;
}

export function updateIssue(issueId: string, fields: Record<string, unknown>) {
  return jira<void>(route`/rest/api/3/issue/${issueId}`, { method: "PUT", body: { fields } });
}

export function setIssueProperty(issueId: string, key: string, value: unknown) {
  return jira<void>(route`/rest/api/3/issue/${issueId}/properties/${key}`, { method: "PUT", body: value });
}

export async function addComment(issueId: string, body: unknown): Promise<string> {
  return (await jira<{ id: string }>(route`/rest/api/3/issue/${issueId}/comment`, { method: "POST", body: { body } })).id;
}

export function updateComment(issueId: string, commentId: string, body: unknown) {
  return jira<void>(route`/rest/api/3/issue/${issueId}/comment/${commentId}`, { method: "PUT", body: { body } });
}

export function deleteComment(issueId: string, commentId: string) {
  return jira<void>(route`/rest/api/3/issue/${issueId}/comment/${commentId}`, { method: "DELETE" });
}

export interface Transition {
  id: string;
  to: { name: string; category: string }; // category: new | indeterminate | done
}

/** Transitions available from the issue's current status. */
export async function getTransitions(issueId: string): Promise<Transition[]> {
  const { transitions } = await jira<{
    transitions: Array<{ id: string; to: { name: string; statusCategory?: { key?: string } } }>;
  }>(route`/rest/api/3/issue/${issueId}/transitions`);
  return transitions.map((t) => ({ id: t.id, to: { name: t.to.name, category: t.to.statusCategory?.key ?? "" } }));
}

export function doTransition(issueId: string, transitionId: string) {
  return jira<void>(route`/rest/api/3/issue/${issueId}/transitions`, { method: "POST", body: { transition: { id: transitionId } } });
}

/** Moves the issue to the status named `to`, if a transition to it exists from where it is now. */
export async function transitionTo(issueId: string, to: string): Promise<boolean> {
  const t = (await getTransitions(issueId)).find((x) => x.to.name === to);
  if (!t) return false;
  await doTransition(issueId, t.id);
  return true;
}

export interface LocalAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export async function listAttachments(issueId: string): Promise<LocalAttachment[]> {
  const raw = await jira<RawIssue>(route`/rest/api/3/issue/${issueId}?fields=attachment`);
  return (raw.fields.attachment ?? []).map((a: any) => ({ id: String(a.id), filename: a.filename, mimeType: a.mimeType, size: a.size }));
}

export async function downloadAttachment(attachmentId: string): Promise<Uint8Array> {
  const res = await api.asApp().requestJira(route`/rest/api/3/attachment/content/${attachmentId}`, { method: "GET" });
  if (!res.ok) throw new Error(`Jira ${res.status} downloading attachment ${attachmentId}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Multipart upload; Jira requires the no-check token header for attachment uploads. */
export async function uploadAttachment(issueId: string, filename: string, mimeType: string, bytes: Uint8Array): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);
  const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueId}/attachments`, {
    method: "POST",
    headers: { Accept: "application/json", "X-Atlassian-Token": "no-check" },
    body: form as unknown as string, // TODO(verify): Forge requestJira accepts FormData bodies
  });
  if (!res.ok) throw new Error(`Jira ${res.status} uploading attachment: ${await res.text()}`);
  const [created] = (await res.json()) as Array<{ id: string }>;
  return String(created!.id);
}

// ---- lookups for the admin page

export async function siteUrl(): Promise<string> {
  const info = await jira<{ baseUrl: string }>(route`/rest/api/3/serverInfo`);
  return info.baseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export interface SpaceInfo {
  key: string;
  name: string;
  issueTypes: string[];
}

export async function listSpaces(): Promise<SpaceInfo[]> {
  const out: SpaceInfo[] = [];
  for (let startAt = 0; startAt < 500; startAt += 50) {
    const page = await jira<{ values: Array<{ key: string; name: string; issueTypes?: Array<{ name: string; subtask?: boolean }> }>; isLast?: boolean }>(
      route`/rest/api/3/project/search?expand=issueTypes&maxResults=50&startAt=${startAt}`,
    );
    for (const p of page.values) {
      out.push({ key: p.key, name: p.name, issueTypes: [...new Set((p.issueTypes ?? []).filter((t) => !t.subtask).map((t) => t.name))] });
    }
    if (page.isLast !== false || page.values.length === 0) break;
  }
  return out;
}

/** Status names used in a space, in workflow order as Jira returns them. */
export async function spaceStatuses(spaceKey: string): Promise<Array<{ name: string; category: string }>> {
  const byType = await jira<Array<{ statuses: Array<{ name: string; statusCategory?: { key?: string } }> }>>(
    route`/rest/api/3/project/${spaceKey}/statuses`,
  );
  const seen = new Map<string, string>();
  for (const t of byType) for (const s of t.statuses) if (!seen.has(s.name)) seen.set(s.name, s.statusCategory?.key ?? "");
  return [...seen].map(([name, category]) => ({ name, category }));
}

export async function listLabels(): Promise<string[]> {
  const out: string[] = [];
  for (let startAt = 0; startAt < 2000; startAt += 1000) {
    const page = await jira<{ values: string[]; isLast?: boolean }>(route`/rest/api/3/label?maxResults=1000&startAt=${startAt}`);
    out.push(...page.values);
    if (page.isLast !== false) break;
  }
  return out;
}

export async function listCustomFields(): Promise<Array<{ id: string; name: string }>> {
  const fields = await jira<Array<{ id: string; name: string; custom: boolean }>>(route`/rest/api/3/field`);
  return fields.filter((f) => f.custom).map((f) => ({ id: f.id, name: f.name })).sort((a, b) => a.name.localeCompare(b.name));
}
