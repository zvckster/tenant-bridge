import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  acceptMac,
  BlobDecryptError,
  type Bundle,
  confirmMac,
  createInvite,
  deriveConnectionKeys,
  generateIdentity,
  macEquals,
  open,
  openBlob,
  parsePairingKey,
  RelayClient,
  RelayError,
  seal,
  sealBlob,
  type Transport,
} from "@tb/protocol";
import { buildRelay, MAIL_TTL_MS } from "../src/app.js";
import { PgStore } from "../src/pg-store.js";
import { MemoryStore, type Store } from "../src/store.js";

// Every scenario runs against each store. Postgres runs when TEST_DATABASE_URL is set.
const PG_URL = process.env.TEST_DATABASE_URL;
let pgStore: PgStore | undefined;
const stores: Array<[string, () => Promise<Store>]> = [["memory", async () => new MemoryStore()]];
if (PG_URL) {
  stores.push([
    "postgres",
    async () => {
      if (!pgStore) {
        pgStore = await PgStore.connect(PG_URL);
        await pgStore.migrate();
      }
      await (pgStore as unknown as { pool: { query(q: string): Promise<unknown> } }).pool.query(
        "TRUNCATE request_nonces, usage_daily, mailbox, connections, invites, installs",
      );
      return pgStore;
    },
  ]);
}
afterAll(async () => pgStore?.close());
let makeStore: () => Promise<Store> = stores[0]![1];

const START = Date.parse("2026-10-26T12:00:00Z");
let clock = START;
const pings: string[] = [];

async function setup(rateLimitPerMinute = 600) {
  const store = await makeStore();
  const relay = buildRelay({
    store,
    now: () => clock,
    rateLimitPerMinute,
    notifier: async (url) => void pings.push(url),
  });
  const transport: Transport = async ({ method, path, body, headers, binaryResponse }) => {
    const payload = typeof body === "string" ? body || undefined : Buffer.from(body);
    const res = await relay.app.inject({ method: method as "GET", url: path, payload, headers });
    if (binaryResponse && res.statusCode === 200) return { status: 200, json: null, bytes: new Uint8Array(res.rawPayload) };
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
  };
  return { store, relay, transport };
}

/** A simulated tenant: what the Forge app does, minus Jira. */
async function tenant(transport: Transport, siteName: string) {
  const id = crypto.randomUUID();
  const keys = generateIdentity();
  const client = new RelayClient(transport, id, keys.signPriv, () => clock);
  await client.register(keys, `https://${id}.hello.atlassian-dev.net/x`);
  const bundle: Bundle = { installId: id, signPub: keys.signPub, dhPub: keys.dhPub, siteName, appVersion: "0.1.0" };
  return { id, keys, client, bundle };
}

async function pair(transport: Transport) {
  const a = await tenant(transport, "acme.atlassian.net");
  const b = await tenant(transport, "globex.atlassian.net");

  // A: create invite; only inviteId goes to the relay.
  const invite = createInvite(clock);
  await a.client.createInvite(invite.inviteId, invite.expiresAt);

  // B: admin types Connection ID + Pairing key.
  const secretB = parsePairingKey(invite.pairingKey);
  const { connectionId } = await b.client.acceptInvite(invite.inviteId, b.bundle, acceptMac(secretB, invite.inviteId, b.bundle));

  // A: verify B's MAC, confirm.
  const pending = (await a.client.listConnections()).find((c) => c.id === connectionId)!;
  expect(macEquals(pending.macB, acceptMac(invite.pairingSecret, invite.inviteId, pending.bundleB))).toBe(true);
  await a.client.confirm(connectionId, a.bundle, confirmMac(invite.pairingSecret, invite.inviteId, connectionId, a.bundle, pending.bundleB));

  // B: verify A's MAC before trusting A's keys.
  const active = (await b.client.listConnections()).find((c) => c.id === connectionId)!;
  expect(active.status).toBe("active");
  expect(macEquals(active.macA!, confirmMac(secretB, invite.inviteId, connectionId, active.bundleA!, b.bundle))).toBe(true);

  const ka = deriveConnectionKeys({ connectionId, me: a.id, peer: b.id, myDhPriv: a.keys.dhPriv, peerDhPub: pending.bundleB.dhPub, pairingSecret: invite.pairingSecret });
  const kb = deriveConnectionKeys({ connectionId, me: b.id, peer: a.id, myDhPriv: b.keys.dhPriv, peerDhPub: active.bundleA!.dhPub, pairingSecret: secretB });
  return { a, b, ka, kb, connectionId, invite };
}

const snapshot = (owner: string) => ({
  type: "ticket.snapshot",
  opId: crypto.randomUUID(),
  ref: { owner, id: "10001", key: "SUP-1" },
  fields: { summary: "Printer on fire", status: { name: "Open", category: "new" }, issueType: "Bug" },
  updatedAt: "2026-10-26T12:00:00Z",
});

describe.each(stores)("relay (%s store)", (_name, factory) => {
  beforeEach(() => {
    pings.length = 0;
    clock = START;
    makeStore = factory;
  });

  it("pairs two tenants and relays end-to-end encrypted messages without keeping them", async () => {
    const { transport, store } = await setup();
    const { a, b, ka, kb, connectionId } = await pair(transport);

    const env = seal(ka, "d", 1, 0, snapshot(a.id));
    expect(await a.client.send(env)).toEqual({ status: "queued" });
    expect(pings).toContain(`https://${b.id}.hello.atlassian-dev.net/x`);

    // Relay storage never contains plaintext.
    const stored = await store.listMail(b.id, 10);
    expect(JSON.stringify(stored)).not.toContain("Printer on fire");

    const [got] = await b.client.mailbox();
    expect(open(kb, got!, [0])).toMatchObject({ fields: { summary: "Printer on fire" } });

    // Ack deletes the ciphertext; only metadata remains.
    expect(await b.client.ack(connectionId, [1])).toEqual({ deleted: 1 });
    expect(await b.client.mailbox()).toHaveLength(0);
    const usage = (await a.client.usage("2026-10-01", "2026-10-31")) as { rows: Array<{ messages: number; direction: string }> };
    expect(usage.rows).toEqual([expect.objectContaining({ messages: 1, direction: "out" })]);
  });

  it("stores encrypted attachment blobs for the recipient only, then deletes them on ack", async () => {
    const { transport, store } = await setup();
    const { a, b, connectionId } = await pair(transport);
    const plain = new Uint8Array(300_000).map((_, i) => i % 251);
    const blobId = crypto.randomUUID();
    const sealed = sealBlob(connectionId, blobId, plain);

    await a.client.putBlob(connectionId, blobId, sealed.data);
    await a.client.putBlob(connectionId, blobId, sealed.data); // idempotent retry
    // The sender cannot read it back; only the recipient can.
    await expect(a.client.getBlob(connectionId, blobId)).rejects.toMatchObject({ code: "blob_not_found" });
    const got = await b.client.getBlob(connectionId, blobId);
    expect(Buffer.from(openBlob(connectionId, blobId, sealed.key, got)).equals(Buffer.from(plain))).toBe(true);
    // Stored bytes are not the plaintext, and a blob opened under another id fails.
    expect(Buffer.from((await store.getBlob(connectionId, blobId))!.data).includes(Buffer.from(plain.subarray(0, 64)))).toBe(false);
    expect(() => openBlob(connectionId, crypto.randomUUID(), sealed.key, got)).toThrow(BlobDecryptError);

    // Bandwidth is metered by size.
    const usage = (await a.client.usage("2026-10-01", "2026-10-31")) as { rows: Array<{ bytes: number; direction: string }> };
    expect(usage.rows.find((r) => r.direction === "out")!.bytes).toBe(sealed.data.length);

    expect(await b.client.deleteBlob(connectionId, blobId)).toEqual({ ok: true });
    await expect(b.client.getBlob(connectionId, blobId)).rejects.toMatchObject({ code: "blob_not_found" });
  });

  it("is idempotent on retransmits and rejects spoofed senders", async () => {
    const { transport } = await setup();
    const { a, b, ka } = await pair(transport);
    const env = seal(ka, "d", 1, 0, snapshot(a.id));
    await a.client.send(env);
    expect(await a.client.send(env)).toEqual({ status: "duplicate" });
    expect(await b.client.mailbox()).toHaveLength(1);

    // B tries to post an envelope claiming to be from A.
    await expect(b.client.send(env)).rejects.toMatchObject({ code: "envelope_mismatch" });
  });

  it("a wrong pairing key is caught by the inviter, and the invite survives a few failures", async () => {
    const { transport } = await setup();
    const a = await tenant(transport, "acme");
    const mallory = await tenant(transport, "mallory");
    const invite = createInvite(clock);
    await a.client.createInvite(invite.inviteId, invite.expiresAt);

    const guessed = createInvite().pairingSecret;
    const { connectionId } = await mallory.client.acceptInvite(invite.inviteId, mallory.bundle, acceptMac(guessed, invite.inviteId, mallory.bundle));
    const pending = (await a.client.listConnections()).find((c) => c.id === connectionId)!;
    expect(macEquals(pending.macB, acceptMac(invite.pairingSecret, invite.inviteId, pending.bundleB))).toBe(false);
    await a.client.reject(connectionId, "bad_mac");

    // Rejected connection cannot carry traffic.
    const kMallory = deriveConnectionKeys({ connectionId, me: mallory.id, peer: a.id, myDhPriv: mallory.keys.dhPriv, peerDhPub: a.keys.dhPub, pairingSecret: guessed });
    await expect(mallory.client.send(seal(kMallory, "d", 1, 0, { x: 1 }))).rejects.toMatchObject({ code: "connection_not_active" });

    // The real partner can still use the invite.
    const b = await tenant(transport, "globex");
    await expect(b.client.acceptInvite(invite.inviteId, b.bundle, acceptMac(invite.pairingSecret, invite.inviteId, b.bundle))).resolves.toHaveProperty("connectionId");
  });

  it("rejects bundles that don't match the registered keys", async () => {
    const { transport } = await setup();
    const a = await tenant(transport, "acme");
    const b = await tenant(transport, "globex");
    const invite = createInvite(clock);
    await a.client.createInvite(invite.inviteId, invite.expiresAt);
    const forged = { ...b.bundle, dhPub: generateIdentity().dhPub };
    await expect(b.client.acceptInvite(invite.inviteId, forged, "mac")).rejects.toMatchObject({ code: "bundle_mismatch" });
  });

  it("revocation drops queued ciphertext and stops traffic", async () => {
    const { transport } = await setup();
    const { a, b, ka, connectionId } = await pair(transport);
    await a.client.send(seal(ka, "d", 1, 0, snapshot(a.id)));
    expect(await b.client.revoke(connectionId)).toEqual({ ok: true, dropped: 1 });
    expect(await b.client.mailbox()).toHaveLength(0);
    await expect(a.client.send(seal(ka, "d", 2, 0, snapshot(a.id)))).rejects.toMatchObject({ code: "connection_not_active" });
  });

  it("expires undelivered mail after the TTL and meters it", async () => {
    const { transport, relay } = await setup();
    const { a, b, ka } = await pair(transport);
    await a.client.send(seal(ka, "d", 1, 0, snapshot(a.id)));
    clock += MAIL_TTL_MS + 1;
    expect(await relay.sweep()).toBe(1);
    expect(await b.client.mailbox()).toHaveLength(0);
    const usage = (await a.client.usage("2026-10-01", "2026-12-31")) as { rows: Array<{ expired: number }> };
    expect(usage.rows.some((r) => r.expired === 1)).toBe(true);
  });

  it("refuses replayed and unsigned requests", async () => {
    const { transport, relay } = await setup();
    const a = await tenant(transport, "acme");
    const res = await relay.app.inject({ method: "GET", url: "/v1/mailbox" });
    expect(res.statusCode).toBe(401);

    // Capture one signed request and replay it.
    let captured: Parameters<Transport>[0] | undefined;
    const spy = new RelayClient(async (req) => {
      captured = req;
      return transport(req);
    }, a.id, a.keys.signPriv, () => clock);
    await spy.mailbox();
    const replay = await relay.app.inject({ method: "GET", url: captured!.path, headers: captured!.headers });
    expect(JSON.parse(replay.body)).toEqual({ error: "replayed_request" });
  });

  it("rate limits per install and enforces ping URL allow-list", async () => {
    const { transport } = await setup(3);
    const a = await tenant(transport, "acme");
    await a.client.mailbox();
    await a.client.mailbox();
    await a.client.mailbox();
    await expect(a.client.mailbox()).rejects.toMatchObject({ status: 429, code: "rate_limited" });

    const other = (await setup()).transport;
    const id = crypto.randomUUID();
    const keys = generateIdentity();
    const c = new RelayClient(other, id, keys.signPriv, () => clock);
    await expect(c.register(keys, "https://169.254.169.254/latest")).rejects.toBeInstanceOf(RelayError);
  });
});
