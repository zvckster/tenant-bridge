import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import {
  AUTH_HEADERS,
  BundleSchema,
  EnvelopeSchema,
  INVITE_TTL_MS,
  MAX_ENVELOPE_BYTES,
  MAX_FAILED_ACCEPTS,
  REQUEST_WINDOW_MS,
  envelopeSize,
  verifyRequest,
} from "@tb/protocol";
import { z } from "zod";
import { monthStart, TIERS, TokenBucket, utcDay } from "./limits.js";
import type { Install, Store, Tier } from "./store.js";

export const MAIL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Tells an installation it has mail. Carries no content. */
export type Notifier = (pingUrl: string) => Promise<void>;

export interface RelayOptions {
  store: Store;
  notifier?: Notifier;
  now?: () => number;
  /** Requests per minute per install. */
  rateLimitPerMinute?: number;
  /** Hostname suffixes allowed for ping URLs (Forge web triggers). Prevents SSRF. */
  pingHostSuffixes?: string[];
  /** Tier for newly registered installs. In production this comes from the verified license. */
  defaultTier?: Tier;
}

declare module "fastify" {
  interface FastifyRequest {
    rawBody: string;
    install?: Install;
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(code);
  }
}

const RegisterBody = z.object({
  installId: z.uuid(),
  signPub: z.string().min(1),
  dhPub: z.string().min(1),
  pingUrl: z.url().optional(),
});
const InviteBody = z.object({ inviteId: z.uuid(), expiresAt: z.number().int() });
const AcceptBody = z.object({ bundle: BundleSchema, mac: z.string().min(1) });
const ConfirmBody = AcceptBody;
const RejectBody = z.object({ reason: z.enum(["declined", "bad_mac"]) });
const SeqList = z.array(z.number().int().positive()).max(1000);
const AckBody = z.object({ connectionId: z.uuid(), seqs: SeqList.default([]), ctrlSeqs: SeqList.default([]) });
const UsageQuery = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new HttpError(400, "invalid_request");
  return r.data;
}

export function buildRelay(opts: RelayOptions) {
  const { store } = opts;
  const now = opts.now ?? Date.now;
  const notifier = opts.notifier ?? (async () => {});
  const perMinute = opts.rateLimitPerMinute ?? 600;
  const bucket = new TokenBucket(perMinute, perMinute / 60_000);
  const pingSuffixes = opts.pingHostSuffixes ?? [".atlassian-dev.net", ".atlassian.net"];

  const app = Fastify({ logger: false, bodyLimit: MAX_ENVELOPE_BYTES + 64 * 1024 });

  // Keep the exact bytes for signature verification.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    req.rawBody = body as string;
    try {
      done(null, body === "" ? {} : JSON.parse(body as string));
    } catch {
      done(new HttpError(400, "invalid_json"), undefined);
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.status).headers(err.headers).send({ error: err.code });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: "invalid_request" });
    app.log.error(err);
    return reply.code(500).send({ error: "internal" });
  });

  function checkPingUrl(url: string | undefined) {
    if (!url) return;
    const u = new URL(url);
    if (u.protocol !== "https:" || !pingSuffixes.some((s) => u.hostname.endsWith(s))) {
      throw new HttpError(400, "ping_url_not_allowed");
    }
  }

  async function verifySigned(req: FastifyRequest, signPub: string, installId: string) {
    const check = verifyRequest({
      headers: req.headers as Record<string, string | undefined>,
      signPub,
      method: req.method,
      path: req.url,
      body: req.rawBody ?? "",
      now: now(),
    });
    if (!check.ok) throw new HttpError(401, check.reason);
    if (!(await store.useNonce(installId, check.nonce, now() + REQUEST_WINDOW_MS * 2, now()))) {
      throw new HttpError(401, "replayed_request");
    }
  }

  // Authenticate every request except registration (which is self-signed below).
  app.addHook("preHandler", async (req) => {
    if (req.method === "POST" && req.url === "/v1/installs") return;
    if (req.url === "/healthz") return;
    const installId = req.headers[AUTH_HEADERS.install];
    if (typeof installId !== "string") throw new HttpError(401, "missing_auth_headers");
    const install = await store.getInstall(installId);
    if (!install) throw new HttpError(401, "unknown_install");
    await verifySigned(req, install.signPub, install.id);
    const wait = bucket.take(install.id, now());
    if (wait > 0) throw new HttpError(429, "rate_limited", { "retry-after": String(Math.ceil(wait / 1000)) });
    req.install = install;
  });

  const me = (req: FastifyRequest) => req.install!;

  async function connectionFor(req: FastifyRequest, id: string) {
    const c = await store.getConnection(id);
    const i = me(req).id;
    if (!c || (c.a !== i && c.b !== i)) throw new HttpError(404, "connection_not_found");
    return c;
  }

  app.get("/healthz", async () => ({ ok: true }));

  // TODO(phase 2): require a Forge Invocation Token here so only real installs of the app can register.
  app.post("/v1/installs", async (req, reply) => {
    const body = parse(RegisterBody, req.body);
    if (req.headers[AUTH_HEADERS.install] !== body.installId) throw new HttpError(401, "install_header_mismatch");
    await verifySigned(req, body.signPub, body.installId);
    checkPingUrl(body.pingUrl);
    if (await store.getInstall(body.installId)) throw new HttpError(409, "install_exists");
    await store.putInstall({
      id: body.installId,
      signPub: body.signPub,
      dhPub: body.dhPub,
      pingUrl: body.pingUrl,
      tier: opts.defaultTier ?? "standard",
      createdAt: now(),
    });
    return reply.code(201).send({ installId: body.installId });
  });

  app.put("/v1/installs/me", async (req) => {
    const body = parse(z.object({ pingUrl: z.url() }), req.body);
    checkPingUrl(body.pingUrl);
    await store.updateInstall(me(req).id, { pingUrl: body.pingUrl });
    return { ok: true };
  });

  app.post("/v1/invites", async (req, reply) => {
    const body = parse(InviteBody, req.body);
    if (body.expiresAt <= now() || body.expiresAt > now() + INVITE_TTL_MS) throw new HttpError(400, "invalid_expiry");
    if (await store.getInvite(body.inviteId)) throw new HttpError(409, "invite_exists");
    await store.putInvite({ inviteId: body.inviteId, installId: me(req).id, expiresAt: body.expiresAt, failures: 0, locked: false, used: false });
    return reply.code(201).send({ inviteId: body.inviteId });
  });

  app.post<{ Params: { inviteId: string } }>("/v1/invites/:inviteId/accept", async (req, reply) => {
    const body = parse(AcceptBody, req.body);
    const acceptor = me(req);
    const invite = await store.getInvite(req.params.inviteId);
    // One generic error so invite ids cannot be probed.
    if (!invite || invite.used || invite.locked || invite.expiresAt < now() || invite.installId === acceptor.id) {
      throw new HttpError(404, "invite_not_available");
    }
    // The bundle must carry the keys this install registered with.
    if (body.bundle.installId !== acceptor.id || body.bundle.signPub !== acceptor.signPub || body.bundle.dhPub !== acceptor.dhPub) {
      throw new HttpError(400, "bundle_mismatch");
    }
    await enforceConnectionLimit(acceptor);
    const id = crypto.randomUUID();
    await store.updateInvite(invite.inviteId, { locked: true });
    await store.putConnection({
      id,
      inviteId: invite.inviteId,
      a: invite.installId,
      b: acceptor.id,
      status: "pending",
      bundleB: body.bundle,
      macB: body.mac,
      createdAt: now(),
      updatedAt: now(),
    });
    await ping(invite.installId);
    return reply.code(201).send({ connectionId: id });
  });

  app.get("/v1/connections", async (req) => {
    const list = await store.listConnections(me(req).id);
    return { connections: list.filter((c) => c.status !== "rejected") };
  });

  app.post<{ Params: { id: string } }>("/v1/connections/:id/confirm", async (req) => {
    const body = parse(ConfirmBody, req.body);
    const c = await connectionFor(req, req.params.id);
    const inviter = me(req);
    if (c.a !== inviter.id || c.status !== "pending") throw new HttpError(409, "not_confirmable");
    if (body.bundle.installId !== inviter.id || body.bundle.signPub !== inviter.signPub || body.bundle.dhPub !== inviter.dhPub) {
      throw new HttpError(400, "bundle_mismatch");
    }
    await enforceConnectionLimit(inviter);
    await store.updateConnection(c.id, { status: "active", bundleA: body.bundle, macA: body.mac, updatedAt: now() });
    await store.updateInvite(c.inviteId, { used: true, locked: false });
    await ping(c.b);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/v1/connections/:id/reject", async (req) => {
    const body = parse(RejectBody, req.body);
    const c = await connectionFor(req, req.params.id);
    if (c.a !== me(req).id || c.status !== "pending") throw new HttpError(409, "not_rejectable");
    await store.updateConnection(c.id, { status: "rejected", updatedAt: now() });
    const invite = await store.getInvite(c.inviteId);
    if (invite) {
      const failures = invite.failures + (body.reason === "bad_mac" ? 1 : 0);
      // A wrong pairing key re-opens the invite until too many failures; a decline burns it.
      const burn = body.reason === "declined" || failures >= MAX_FAILED_ACCEPTS;
      await store.updateInvite(c.inviteId, { failures, locked: false, used: burn });
    }
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/v1/connections/:id", async (req) => {
    const c = await connectionFor(req, req.params.id);
    await store.updateConnection(c.id, { status: "revoked", updatedAt: now() });
    const dropped = await store.deleteMailForConnection(c.id);
    await ping(c.a === me(req).id ? c.b : c.a);
    return { ok: true, dropped };
  });

  app.post<{ Params: { id: string } }>("/v1/connections/:id/messages", async (req, reply) => {
    const env = parse(EnvelopeSchema, req.body);
    const sender = me(req);
    const c = await connectionFor(req, req.params.id);
    if (c.status !== "active") throw new HttpError(409, "connection_not_active");
    if (env.connectionId !== c.id || env.sender !== sender.id) throw new HttpError(400, "envelope_mismatch");
    const bytes = envelopeSize(env);
    if (bytes > MAX_ENVELOPE_BYTES) throw new HttpError(413, "envelope_too_large");
    await enforceQuota(sender, bytes);

    const recipient = c.a === sender.id ? c.b : c.a;
    const stored = await store.putMail({ env, recipient, bytes, storedAt: now() });
    if (!stored) return reply.code(200).send({ status: "duplicate" });
    await store.addUsage(utcDay(now()), c.id, sender.id, { messages: 1, bytes });
    await ping(recipient);
    return reply.code(202).send({ status: "queued" });
  });

  app.get<{ Querystring: { limit?: string } }>("/v1/mailbox", async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 500);
    const items = await store.listMail(me(req).id, limit);
    return { envelopes: items.map((m) => m.env) };
  });

  app.post("/v1/mailbox/ack", async (req) => {
    const body = parse(AckBody, req.body);
    const c = await connectionFor(req, body.connectionId);
    const sender = c.a === me(req).id ? c.b : c.a;
    const deleted =
      (await store.deleteMail(c.id, sender, "d", body.seqs, me(req).id)) +
      (await store.deleteMail(c.id, sender, "c", body.ctrlSeqs, me(req).id));
    return { deleted };
  });

  app.get("/v1/usage", async (req) => {
    const q = parse(UsageQuery, req.query);
    const conns = await store.listConnections(me(req).id);
    const rows = await store.listUsage(conns.map((c) => c.id), q.from, q.to);
    const sentThisMonth = await monthlyBytes(me(req).id);
    return {
      tier: me(req).tier,
      limits: TIERS[me(req).tier],
      sentThisMonth,
      rows: rows.map((r) => ({ ...r, direction: r.sender === me(req).id ? "out" : "in" })),
    };
  });

  async function monthlyBytes(installId: string) {
    const conns = await store.listConnections(installId);
    const rows = await store.listUsage(conns.map((c) => c.id), monthStart(now()), utcDay(now()));
    return rows.filter((r) => r.sender === installId).reduce((s, r) => s + r.bytes, 0);
  }

  async function enforceQuota(install: Install, bytes: number) {
    if ((await monthlyBytes(install.id)) + bytes > TIERS[install.tier].monthlyBytes) {
      throw new HttpError(429, "quota_exceeded");
    }
  }

  async function enforceConnectionLimit(install: Install) {
    const active = (await store.listConnections(install.id)).filter((c) => c.status === "active");
    if (active.length >= TIERS[install.tier].connections) throw new HttpError(403, "connection_limit_reached");
  }

  async function ping(installId: string) {
    const i = await store.getInstall(installId);
    if (i?.pingUrl) notifier(i.pingUrl).catch(() => {}); // best effort; receivers also poll
  }

  /** Deletes undelivered ciphertext older than the TTL and meters it as expired. */
  async function sweep() {
    const expired = await store.expireMail(now() - MAIL_TTL_MS);
    await store.purgeExpired?.(now());
    for (const e of expired) await store.addUsage(utcDay(now()), e.connectionId, e.sender, { expired: 1 });
    return expired.length;
  }

  return { app, sweep };
}

export type { FastifyReply };
