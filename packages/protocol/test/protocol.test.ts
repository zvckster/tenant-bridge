import { describe, expect, it } from "vitest";
import {
  acceptMac,
  authorizeInbound,
  type Bundle,
  canonicalJson,
  confirmMac,
  createInvite,
  DecryptError,
  deriveConnectionKeys,
  dueForRetransmit,
  emptyInbox,
  emptyOutbox,
  fingerprint,
  generateIdentity,
  type LocalIssue,
  macEquals,
  markApplied,
  missingSeqs,
  onAck,
  open,
  parsePairingKey,
  type Payload,
  PolicySchema,
  receive,
  receiveControl,
  takeReady,
  recordSent,
  seal,
  shareFields,
  inOutboundScope,
  signRequest,
  verifyRequest,
} from "../src/index.js";

function pairUp() {
  const a = { id: crypto.randomUUID(), keys: generateIdentity() };
  const b = { id: crypto.randomUUID(), keys: generateIdentity() };
  const bundle = (x: typeof a, siteName: string): Bundle => ({
    installId: x.id,
    signPub: x.keys.signPub,
    dhPub: x.keys.dhPub,
    siteName,
    appVersion: "0.1.0",
  });
  return { a, b, bundleA: bundle(a, "acme.atlassian.net"), bundleB: bundle(b, "globex.atlassian.net") };
}

describe("encoding", () => {
  it("canonical JSON sorts keys and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [1, "x"] } })).toBe('{"a":{"c":[1,"x"]},"b":1}');
  });
});

describe("pairing", () => {
  it("round-trips the human pairing key", () => {
    const inv = createInvite();
    expect(inv.pairingKey).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{1,4})+$/);
    expect(parsePairingKey(inv.pairingKey.toLowerCase())).toBe(inv.pairingSecret);
    expect(() => parsePairingKey("AAAA")).toThrow();
  });

  it("MACs bind both bundles to the pairing secret", () => {
    const { bundleA, bundleB } = pairUp();
    const inv = createInvite();
    const typed = parsePairingKey(inv.pairingKey);
    const macB = acceptMac(typed, inv.inviteId, bundleB);
    expect(macEquals(macB, acceptMac(inv.pairingSecret, inv.inviteId, bundleB))).toBe(true);

    // A relay swapping B's keys for its own cannot produce a valid MAC.
    const attacker = generateIdentity();
    const swapped = { ...bundleB, dhPub: attacker.dhPub };
    expect(macEquals(macB, acceptMac(inv.pairingSecret, inv.inviteId, swapped))).toBe(false);

    const connId = crypto.randomUUID();
    const macA = confirmMac(inv.pairingSecret, inv.inviteId, connId, bundleA, bundleB);
    expect(macEquals(macA, confirmMac(typed, inv.inviteId, connId, bundleA, bundleB))).toBe(true);
    expect(macEquals(macA, confirmMac(typed, inv.inviteId, crypto.randomUUID(), bundleA, bundleB))).toBe(false);
  });

  it("fingerprints are stable and differ per key", () => {
    const k1 = generateIdentity();
    const k2 = generateIdentity();
    expect(fingerprint(k1)).toMatch(/^(\d{5} ){7}\d{5}$/);
    expect(fingerprint(k1)).toBe(fingerprint(k1));
    expect(fingerprint(k1)).not.toBe(fingerprint(k2));
  });
});

describe("envelopes", () => {
  const { a, b } = pairUp();
  const secret = createInvite().pairingSecret;
  const connectionId = crypto.randomUUID();
  const ka = deriveConnectionKeys({ connectionId, me: a.id, peer: b.id, myDhPriv: a.keys.dhPriv, peerDhPub: b.keys.dhPub, pairingSecret: secret });
  const kb = deriveConnectionKeys({ connectionId, me: b.id, peer: a.id, myDhPriv: b.keys.dhPriv, peerDhPub: a.keys.dhPub, pairingSecret: secret });

  it("both sides derive the same root", () => {
    expect(ka.root).toBe(kb.root);
  });

  it("encrypts end to end and hides content", () => {
    const env = seal(ka, "d", 1, 0, { type: "ack", appliedUpTo: 7, secret: "do not leak" });
    expect(JSON.stringify(env)).not.toContain("do not leak");
    expect(open(kb, env, [0])).toEqual({ appliedUpTo: 7, secret: "do not leak", type: "ack" });
  });

  it("rejects tampered ciphertext and header", () => {
    const env = seal(ka, "d", 1, 0, { hello: "world" });
    const flipped = env.ct.slice(0, -2) + (env.ct.endsWith("A") ? "BA" : "AA");
    expect(() => open(kb, { ...env, ct: flipped }, [0])).toThrow(DecryptError);
    expect(() => open(kb, { ...env, seq: 2 }, [0])).toThrow(DecryptError);
    expect(() => open(kb, env, [1])).toThrow(DecryptError);
    expect(() => open(kb, { ...env, ch: "c" }, [0])).toThrow(DecryptError); // channel is authenticated
  });

  it("a sender cannot decrypt with its own receive direction (keys are per direction)", () => {
    const env = seal(ka, "d", 1, 0, { x: 1 });
    expect(() => open(ka, env, [0])).toThrow(DecryptError); // sender != ka.peer
  });
});

describe("reliability", () => {
  const env = (seq: number) => ({ v: 1 as const, connectionId: crypto.randomUUID(), sender: crypto.randomUUID(), ch: "d" as const, seq, epoch: 0, nonce: "x".repeat(32), ct: "c" });

  it("orders, buffers gaps and deduplicates", () => {
    let s = receive(emptyInbox(), env(2)).state;
    let t = takeReady(s);
    expect(t.ready).toHaveLength(0);
    expect(missingSeqs(t.state)).toEqual([1]);
    s = receive(t.state, env(1)).state;
    t = takeReady(s);
    expect(t.ready.map((e) => e.seq)).toEqual([1, 2]);
    s = markApplied(markApplied(t.state, 1), 2);
    expect(receive(s, env(2)).duplicate).toBe(true);
    expect(missingSeqs(s)).toEqual([]);
  });

  it("releases every in-order envelope of one batch together", () => {
    // Regression: several consecutive envelopes arriving in one mailbox pull.
    let s = emptyInbox();
    for (const seq of [1, 2, 3]) s = receive(s, env(seq)).state;
    expect(takeReady(s).ready.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("control channel drops stale messages and is never stored for retransmit", () => {
    let s = emptyInbox();
    const c = (seq: number) => ({ ...env(seq), ch: "c" as const });
    let r = receiveControl(s, c(2));
    expect(r.fresh).toBe(true);
    s = r.state;
    expect(receiveControl(s, c(1)).fresh).toBe(false);
    expect(() => receive(s, c(3))).toThrow();
    expect(recordSent(emptyOutbox(), c(1), 0).entries).toEqual({});
  });

  it("retransmits overdue and nacked envelopes, forgets acked ones", () => {
    let o = emptyOutbox();
    o = recordSent(o, env(1), 0);
    o = recordSent(o, env(2), 0);
    expect(dueForRetransmit(o, 1000)).toHaveLength(0);
    expect(dueForRetransmit(o, 1000, [2]).map((e) => e.seq)).toEqual([2]);
    expect(dueForRetransmit(o, 61_000)).toHaveLength(2);
    o = onAck(o, 1);
    expect(Object.keys(o.entries)).toEqual(["2"]);
  });
});

describe("policy", () => {
  const me = crypto.randomUUID();
  const partner = crypto.randomUUID();
  const policy = PolicySchema.parse({
    outbound: { spaces: ["SUP"], fields: ["description", "priority"], orgLabel: "Acme" },
    partner: { statusTransitions: [{ from: "Waiting for vendor", to: "In Progress" }], editableFields: ["priority"] },
    inbound: { targetSpace: "VEND", issueType: "Task" },
  });
  const myTicket = { owner: me, id: "100", key: "SUP-1" };
  const theirTicket = { owner: partner, id: "900", key: "GLX-9" };
  const opId = crypto.randomUUID();
  const ctx = { me, partner };

  it("shares only allowed fields and skips secured issues", () => {
    const issue: LocalIssue = {
      id: "100", key: "SUP-1", spaceKey: "SUP", issueType: "Bug", updatedAt: "now",
      fields: { summary: "S", status: { name: "Open", category: "new" }, issueType: "Bug", description: { d: 1 }, priority: "High", labels: ["internal"] },
    };
    expect(shareFields(policy, issue)).toEqual({ summary: "S", status: { name: "Open", category: "new" }, issueType: "Bug", description: { d: 1 }, priority: "High" });
    expect(inOutboundScope(policy, issue)).toBe(true);
    expect(inOutboundScope(policy, { ...issue, securityLevel: "Confidential" })).toBe(false);
    expect(inOutboundScope(policy, { ...issue, spaceKey: "HR" })).toBe(false);
  });

  const decide = (p: Payload, extra = {}) => authorizeInbound(policy, p, { ...ctx, ...extra });

  it("lets the partner comment and edit only its own comments", () => {
    const up = (originTenant: string) => ({ type: "comment.upsert" as const, opId, ticket: myTicket, origin: { tenant: originTenant, id: "c1" }, author: "x", body: {}, updatedAt: "t" });
    expect(decide(up(partner)).allow).toBe(true);
    expect(decide(up(partner), { existingOriginTenant: partner }).allow).toBe(true);
    expect(decide(up(partner), { existingOriginTenant: me })).toEqual({ allow: false, reason: "not_own_comment" });
    expect(decide(up(me))).toEqual({ allow: false, reason: "origin_not_partner" });
  });

  it("enforces status transitions and editable fields", () => {
    const st = { type: "status.request" as const, opId, ticket: myTicket, to: "In Progress" };
    expect(decide(st, { currentStatus: "Waiting for vendor" }).allow).toBe(true);
    expect(decide(st, { currentStatus: "Open" }).allow).toBe(false);
    expect(decide({ ...st, to: "Closed" }, { currentStatus: "Waiting for vendor" }).allow).toBe(false);
    expect(decide({ ...st, ticket: theirTicket }).allow).toBe(false);

    const fr = { type: "field.request" as const, opId, ticket: myTicket, field: "priority", value: "Low" };
    expect(decide(fr).allow).toBe(true);
    expect(decide({ ...fr, field: "description" }).allow).toBe(false);
    expect(decide({ ...fr, field: "labels" }).allow).toBe(false); // not visible to partner
  });

  it("denies by default: ticket creation and attachments", () => {
    expect(decide({ type: "ticket.create.request", opId, origin: { tenant: partner, id: "1" }, fields: { summary: "x" } }).allow).toBe(false);
    expect(decide({ type: "attachment.offer", opId, ticket: myTicket, origin: { tenant: partner, id: "a" }, filename: "f.pdf", mimeType: "application/pdf", size: 10, sha256: "h", chunks: 1 }).allow).toBe(false);
  });

  it("snapshots are only accepted from the owner", () => {
    const snap = (ref: typeof myTicket) => ({ type: "ticket.snapshot" as const, opId, ref, fields: { summary: "", status: { name: "", category: "" }, issueType: "" }, updatedAt: "" });
    expect(decide(snap(theirTicket)).allow).toBe(true);
    expect(decide(snap(myTicket)).allow).toBe(false);
  });
});

describe("request auth", () => {
  it("verifies signature, body and freshness", () => {
    const k = generateIdentity();
    const installId = crypto.randomUUID();
    const headers = signRequest({ installId, signPriv: k.signPriv, method: "POST", path: "/v1/x", body: '{"a":1}', now: 1_000_000 });
    const base = { headers, signPub: k.signPub, method: "POST", path: "/v1/x", body: '{"a":1}', now: 1_000_000 };
    expect(verifyRequest(base).ok).toBe(true);
    expect(verifyRequest({ ...base, body: '{"a":2}' }).ok).toBe(false);
    expect(verifyRequest({ ...base, path: "/v1/y" }).ok).toBe(false);
    expect(verifyRequest({ ...base, now: 1_000_000 + 10 * 60_000 })).toEqual({ ok: false, reason: "stale_request" });
  });
});
