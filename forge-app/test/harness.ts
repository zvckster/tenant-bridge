/**
 * Test harness: runs the real Forge app code for several simulated tenants against
 * the real relay (in-process). Forge storage and Jira are faked per tenant; the app
 * code is unchanged. Calls must be sequential: `as(tenant, fn)` switches context.
 */
import { buildRelay } from "../../relay/src/app.js";
import { MemoryStore } from "../../relay/src/store.js";

// ---------------------------------------------------------------- fake Jira

export interface FakeComment {
  id: string;
  body: any;
  author: string;
  visibility?: { type: string; value: string } | null;
  updated: string;
}

export interface FakeIssue {
  id: string;
  key: string;
  project: string;
  issuetype: string;
  summary: string;
  description?: any;
  status: string;
  priority?: string;
  labels: string[];
  duedate?: string;
  security?: string;
  updated: string;
  comments: FakeComment[];
  properties: Record<string, unknown>;
  attachments: Array<{ id: string; filename: string; mimeType: string; content: Uint8Array; author: string }>;
}

const STATUS_CATEGORY: Record<string, string> = { Open: "new", "In Progress": "indeterminate", "Waiting for vendor": "indeterminate", Done: "done" };

export class FakeJira {
  issues = new Map<string, FakeIssue>();
  private nextId = 10000;
  private counters: Record<string, number> = {};
  /** Number of upcoming write requests that fail with 503 (transient outage). */
  failWrites = 0;
  /** Whether the user calling the admin page is a Jira administrator. */
  userIsAdmin = true;

  constructor(readonly site: string) {}

  createIssue(project: string, f: Partial<FakeIssue>): FakeIssue {
    const id = String(this.nextId++);
    this.counters[project] = (this.counters[project] ?? 0) + 1;
    const issue: FakeIssue = {
      id,
      key: `${project}-${this.counters[project]}`,
      project,
      issuetype: f.issuetype ?? "Task",
      summary: f.summary ?? "",
      description: f.description,
      status: f.status ?? "Open",
      priority: f.priority,
      labels: f.labels ?? [],
      duedate: f.duedate,
      security: f.security,
      updated: new Date().toISOString(),
      comments: [],
      properties: {},
      attachments: [],
    };
    this.issues.set(id, issue);
    return issue;
  }

  get(idOrKey: string): FakeIssue {
    const i = this.issues.get(idOrKey) ?? [...this.issues.values()].find((x) => x.key === idOrKey);
    if (!i) throw new HttpFail(404, "issue not found");
    return i;
  }

  addComment(issue: FakeIssue, body: any, author: string, visibility?: FakeComment["visibility"]): FakeComment {
    const c = { id: String(this.nextId++), body, author, visibility: visibility ?? null, updated: new Date().toISOString() };
    issue.comments.push(c);
    return c;
  }

  addAttachment(issue: FakeIssue, filename: string, mimeType: string, content: Uint8Array, author: string) {
    const a = { id: String(this.nextId++), filename, mimeType, content, author };
    issue.attachments.push(a);
    return a;
  }

  private toJson(i: FakeIssue) {
    return {
      id: i.id,
      key: i.key,
      fields: {
        summary: i.summary,
        description: i.description ?? null,
        status: { name: i.status, statusCategory: { key: STATUS_CATEGORY[i.status] ?? "new" } },
        issuetype: { name: i.issuetype },
        priority: i.priority ? { name: i.priority } : null,
        labels: i.labels,
        duedate: i.duedate ?? null,
        project: { key: i.project },
        security: i.security ? { name: i.security } : null,
        updated: i.updated,
        attachment: i.attachments.map((a) => ({ id: a.id, filename: a.filename, mimeType: a.mimeType, size: a.content.length, author: { displayName: a.author } })),
      },
    };
  }

  /** Tiny JQL subset: AND-ed clauses of the forms the app generates. */
  private matches(i: FakeIssue, jql: string): boolean {
    const list = (s: string) => s.split(",").map((x) => x.trim().replace(/^"|"$/g, ""));
    for (const m of jql.matchAll(/\bkey\s*=\s*"?([A-Z]+-\d+)"?/g)) if (i.key !== m[1]) return false;
    for (const m of jql.matchAll(/\bproject\s+in\s*\(([^)]*)\)/g)) if (!list(m[1]!).includes(i.project)) return false;
    for (const m of jql.matchAll(/\bissuetype\s+in\s*\(([^)]*)\)/g)) if (!list(m[1]!).includes(i.issuetype)) return false;
    for (const m of jql.matchAll(/\bid\s+in\s*\(([^)]*)\)/g)) if (!list(m[1]!).includes(i.id)) return false;
    for (const m of jql.matchAll(/\blabels\s*=\s*"?([\w-]+)"?/g)) if (!i.labels.includes(m[1]!)) return false;
    return true;
  }

  async handle(method: string, url: string, body: any): Promise<{ status: number; json?: unknown; bytes?: Uint8Array }> {
    const [path, query = ""] = url.split("?");
    const q = new URLSearchParams(query);
    const seg = path!.split("/").filter(Boolean).map(decodeURIComponent); // rest api 3 ...
    const route = `${method} ${path}`;
    const isWrite = method !== "GET" && !(method === "POST" && seg[3] === "search");
    if (isWrite && this.failWrites > 0) {
      this.failWrites--;
      return { status: 503, json: { errorMessages: ["temporarily unavailable"] } };
    }
    const touch = (i: FakeIssue) => (i.updated = new Date().toISOString());

    try {
      if (seg[3] === "mypermissions") return { status: 200, json: { permissions: { ADMINISTER: { havePermission: this.userIsAdmin } } } };

      if (seg[3] === "search" && seg[4] === "jql") {
        const hits = [...this.issues.values()].filter((i) => this.matches(i, body.jql)).slice(0, body.maxResults ?? 50);
        return { status: 200, json: { issues: hits.map((i) => ({ id: i.id, key: i.key })) } };
      }

      if (seg[3] === "attachment" && seg[4] === "content") {
        const att = [...this.issues.values()].flatMap((i) => i.attachments).find((a) => a.id === seg[5]);
        if (!att) throw new HttpFail(404, "attachment not found");
        return { status: 200, bytes: att.content };
      }

      if (seg[3] !== "issue") throw new HttpFail(404, `no route ${route}`);

      if (seg.length === 4 && method === "POST") {
        const f = body.fields;
        const i = this.createIssue(f.project.key, {
          issuetype: f.issuetype.name,
          summary: f.summary,
          description: f.description,
          labels: f.labels,
          duedate: f.duedate,
          priority: f.priority?.name,
        });
        return { status: 201, json: { id: i.id, key: i.key } };
      }

      const issue = this.get(seg[4]!);
      const sub = seg[5];

      if (!sub && method === "GET") return { status: 200, json: this.toJson(issue) };
      if (!sub && method === "PUT") {
        const f = body.fields;
        if ("summary" in f) issue.summary = f.summary;
        if ("description" in f) issue.description = f.description;
        if ("duedate" in f) issue.duedate = f.duedate;
        if ("labels" in f) issue.labels = f.labels;
        if ("priority" in f) issue.priority = f.priority?.name;
        touch(issue);
        return { status: 204 };
      }
      if (sub === "properties" && method === "PUT") {
        issue.properties[seg[6]!] = body;
        return { status: 200, json: {} };
      }
      if (sub === "transitions") {
        const others = Object.keys(STATUS_CATEGORY).filter((s) => s !== issue.status);
        if (method === "GET") return { status: 200, json: { transitions: others.map((s) => ({ id: `t-${s}`, to: { name: s } })) } };
        const to = String(body.transition.id).replace(/^t-/, "");
        if (!others.includes(to)) throw new HttpFail(400, "bad transition");
        issue.status = to;
        touch(issue);
        return { status: 204 };
      }
      if (sub === "comment") {
        const cid = seg[6];
        if (!cid && method === "POST") {
          const c = this.addComment(issue, body.body, "Tenant Bridge (app)");
          touch(issue);
          return { status: 201, json: { id: c.id } };
        }
        const c = issue.comments.find((x) => x.id === cid);
        if (!c) throw new HttpFail(404, "comment not found");
        if (method === "GET") return { status: 200, json: { id: c.id, body: c.body, author: { displayName: c.author }, visibility: c.visibility ?? undefined, updated: c.updated } };
        if (method === "PUT") {
          c.body = body.body;
          c.updated = new Date().toISOString();
          return { status: 200, json: {} };
        }
        if (method === "DELETE") {
          issue.comments = issue.comments.filter((x) => x.id !== cid);
          return { status: 204 };
        }
      }
      if (sub === "attachments" && method === "POST") {
        if (!(body instanceof FormData)) throw new HttpFail(415, "multipart/form-data required");
        const file = body.get("file") as File;
        const a = this.addAttachment(issue, file.name, file.type, new Uint8Array(await file.arrayBuffer()), "Tenant Bridge (app)");
        return { status: 200, json: [{ id: a.id, filename: a.filename }] };
      }
      throw new HttpFail(404, `no route ${route}`);
    } catch (err) {
      if (err instanceof HttpFail) return { status: err.status, json: { errorMessages: [err.message] } };
      throw err;
    }
  }
}

class HttpFail extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- world: tenants + relay

interface KvEntry {
  value: unknown;
  expiresAt?: number;
}

export interface Tenant {
  name: string;
  jira: FakeJira;
  kv: Map<string, KvEntry>;
  pingUrl: string;
}

export const RELAY_URL = "https://relay.test";
process.env.RELAY_URL = RELAY_URL;

export const relayStore = new MemoryStore();
export const pings: string[] = [];
export const relay = buildRelay({
  store: relayStore,
  notifier: async (url) => void pings.push(url),
  rateLimitPerMinute: 100_000,
  now: () => Date.now(), // late-bound so tests can move the clock
});

const tenants = new Map<string, Tenant>();
let current: Tenant | undefined;

export function addTenant(name: string, site: string): Tenant {
  const t = { name, jira: new FakeJira(site), kv: new Map(), pingUrl: `https://${name}.hello.atlassian-dev.net/ping` };
  tenants.set(name, t);
  return t;
}

export function tenantByPing(url: string): Tenant | undefined {
  return [...tenants.values()].find((t) => t.pingUrl === url);
}

export async function as<T>(t: Tenant, fn: () => Promise<T>): Promise<T> {
  const prev = current;
  current = t;
  try {
    return await fn();
  } finally {
    current = prev;
  }
}

function ctx(): Tenant {
  if (!current) throw new Error("no tenant context: wrap the call in as(tenant, ...)");
  return current;
}

// ---------------------------------------------------------------- @forge/kvs mock

function kvGet(key: string) {
  const e = ctx().kv.get(key);
  if (!e) return undefined;
  if (e.expiresAt !== undefined && e.expiresAt < Date.now()) {
    ctx().kv.delete(key);
    return undefined;
  }
  return structuredClone(e.value);
}

function kvSet(key: string, value: unknown, opts?: { keyPolicy?: string; ttl?: { value: number; unit: string } }) {
  if (opts?.keyPolicy === "FAIL_IF_EXISTS" && kvGet(key) !== undefined) throw new Error("KEY_ALREADY_EXISTS");
  const mult: Record<string, number> = { SECONDS: 1e3, MINUTES: 6e4, HOURS: 36e5, DAYS: 864e5 };
  const expiresAt = opts?.ttl ? Date.now() + opts.ttl.value * mult[opts.ttl.unit]! : undefined;
  ctx().kv.set(key, { value: structuredClone(value), expiresAt });
}

export const kvsMock = {
  kvs: {
    get: async (k: string) => kvGet(k),
    set: async (k: string, v: unknown, o?: any) => kvSet(k, v, o),
    delete: async (k: string) => void ctx().kv.delete(k),
    getSecret: async (k: string) => kvGet(`secret:${k}`),
    setSecret: async (k: string, v: unknown) => kvSet(`secret:${k}`, v),
    deleteSecret: async (k: string) => void ctx().kv.delete(`secret:${k}`),
  },
};

// ---------------------------------------------------------------- @forge/api mock

type Route = { value: string };

function route(strings: TemplateStringsArray, ...vals: unknown[]): Route {
  return { value: strings.reduce((acc, s, i) => acc + s + (i < vals.length ? encodeURIComponent(String(vals[i])) : ""), "") };
}

function response(status: number, payload?: unknown, bytes?: Uint8Array) {
  const text = bytes ? "" : payload === undefined ? "" : JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text),
    text: async () => text,
    arrayBuffer: async () => (bytes ?? new Uint8Array()).slice().buffer,
  };
}

const requestJira = async (r: Route, init?: { method?: string; body?: unknown }) => {
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
  const res = await ctx().jira.handle(init?.method ?? "GET", r.value, body);
  return response(res.status, res.json, res.bytes);
};

const api = {
  asApp: () => ({ requestJira }),
  asUser: () => ({ requestJira }),
};

async function fetchMock(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) {
  if (!url.startsWith(RELAY_URL)) throw new Error(`egress not allowed in tests: ${url}`);
  const res = await relay.app.inject({
    method: (init?.method ?? "GET") as "GET",
    url: url.slice(RELAY_URL.length),
    headers: init?.headers,
    payload: init?.body,
  });
  return { status: res.statusCode, text: async () => res.body };
}

export const apiMock = {
  default: api,
  route,
  fetch: fetchMock,
  webTrigger: { getUrl: async () => ctx().pingUrl },
};

