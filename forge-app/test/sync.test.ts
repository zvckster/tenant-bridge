import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@forge/kvs", async () => (await import("./harness.js")).kvsMock);
vi.mock("@forge/api", async () => (await import("./harness.js")).apiMock);

const H = await import("./harness.js");
const { onIssueEvent, onRelayPing, onTick, handler } = await import("../src/index.js");
const pairing = await import("../src/pairing.js");

const { as, addTenant, pings, relayStore, tenantByPing } = H;
type Tenant = ReturnType<typeof addTenant>;

const acme = addTenant("acme", "acme.atlassian.net");
const globex = addTenant("globex", "globex.atlassian.net");

const doc = (text: string) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const textOf = (adf: any): string => JSON.stringify(adf).match(/"text":"([^"]*)"/g)?.map((m) => m.slice(8, -1)).join(" ") ?? "";

/** Delivers relay pings until both sides are quiet, as Forge web triggers would. */
async function deliver(maxPings = 500) {
  for (let i = 0; pings.length > 0; i++) {
    if (i >= maxPings) throw new Error("sync did not settle (ping storm?)");
    const url = pings.shift()!;
    const t = tenantByPing(url);
    if (t) await as(t, () => onRelayPing());
  }
}

let clockOffset = 0;
const realNow = Date.now.bind(Date);
vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffset);
const advance = (ms: number) => (clockOffset += ms);

/** What Jira fires when a person (not the app) acts. */
async function userCreates(t: Tenant, project: string, f: Partial<H.FakeIssue>) {
  const issue = t.jira.createIssue(project, f);
  await as(t, () => onIssueEvent({ eventType: "avi:jira:created:issue", issue: { id: issue.id, key: issue.key } }));
  return issue;
}
async function userComments(t: Tenant, issue: H.FakeIssue, text: string, author: string, visibility?: { type: string; value: string }) {
  const c = t.jira.addComment(issue, doc(text), author, visibility);
  await as(t, () => onIssueEvent({ eventType: "avi:jira:commented:issue", issue: { id: issue.id, key: issue.key }, comment: { id: c.id } }));
  return c;
}
async function userTransitions(t: Tenant, issue: H.FakeIssue, to: string) {
  issue.status = to;
  await as(t, () =>
    onIssueEvent({ eventType: "avi:jira:updated:issue", issue: { id: issue.id, key: issue.key }, changelog: { items: [{ field: "status", fieldId: "status", toString: to }] } }),
  );
}
async function userEdits(t: Tenant, issue: H.FakeIssue, field: "summary", value: string) {
  issue[field] = value;
  await as(t, () =>
    onIssueEvent({ eventType: "avi:jira:updated:issue", issue: { id: issue.id, key: issue.key }, changelog: { items: [{ field, fieldId: field, toString: value }] } }),
  );
}

const acmePolicy = (attachments = false) => ({
  outbound: {
    spaces: ["SUP"],
    jql: "labels = share-globex",
    fields: ["description", "priority"],
    orgLabel: "Acme",
    attachments: { enabled: attachments, maxBytes: 1024 * 1024, mimeTypes: ["application/pdf", "image/png"] },
  },
  partner: {
    statusTransitions: [{ from: "Waiting for vendor", to: "In Progress" }],
    editableFields: ["priority"],
    attachmentAdd: { enabled: attachments, maxBytes: 1024 * 1024, mimeTypes: ["image/png"] },
  },
  inbound: { targetSpace: "ACMEIN", issueType: "Task" },
});
const globexPolicy = (attachments = false) => ({
  outbound: { spaces: ["GLX"], orgLabel: "Globex", attachments: { enabled: attachments, maxBytes: 1024 * 1024, mimeTypes: [] } },
  inbound: { targetSpace: "VEND", issueType: "Task", attachments: { enabled: attachments, maxBytes: 1024 * 1024, mimeTypes: [] } },
});
const randomBytes = (n: number) => new Uint8Array(Array.from({ length: n }, (_, i) => (i * 7919 + n) % 251));
async function userAttaches(t: Tenant, issue: H.FakeIssue, filename: string, mimeType: string, bytes: Uint8Array, author: string) {
  const a = t.jira.addAttachment(issue, filename, mimeType, bytes, author);
  await as(t, () => onIssueEvent({ eventType: "avi:jira:created:attachment", issue: { id: issue.id, key: issue.key }, attachment: { id: a.id } }));
  return a;
}
const keysIn = (t: Tenant, prefix: string) => [...t.kv.keys()].filter((k) => k.startsWith(prefix));

const mirrorsIn = (t: Tenant) => [...t.jira.issues.values()].filter((i) => i.labels.includes("tb-mirror"));
let connectionId = "";

beforeAll(async () => {
  const invite = await as(acme, () => pairing.createInvite());
  await as(globex, () => pairing.acceptInvite({ connectionId: invite.connectionId, pairingKey: invite.pairingKey, siteName: "globex.atlassian.net" }));
  const pending = await as(acme, () => pairing.refreshConnections());
  expect(pending[0]).toMatchObject({ status: "pending_approval", peerBundle: { siteName: "globex.atlassian.net" } });
  connectionId = pending[0]!.id;
  await as(acme, () => pairing.approve(connectionId, "acme.atlassian.net"));
  const active = await as(globex, () => pairing.refreshConnections());
  expect(active[0]).toMatchObject({ status: "active", peerFingerprint: pending[0]!.peerFingerprint ? expect.any(String) : undefined });

  await as(acme, () => pairing.savePolicy(connectionId, acmePolicy()));
  await as(globex, () => pairing.savePolicy(connectionId, globexPolicy()));
  await deliver();
});

describe("two tenants through the real relay", () => {
  it("shares only opted-in tickets, and the relay never sees plaintext", async () => {
    const shared = await userCreates(acme, "SUP", { summary: "Printer on fire", description: doc("Flames since 9am"), labels: ["share-globex"], priority: "High" });
    await userCreates(acme, "SUP", { summary: "Internal only", labels: [] });
    await userCreates(acme, "SUP", { summary: "Secret", labels: ["share-globex"], security: "Confidential" });
    await userCreates(acme, "HR", { summary: "Salaries", labels: ["share-globex"] });

    // While in flight, the relay holds ciphertext only.
    expect(JSON.stringify(await relayStore.listMail((await as(globex, async () => (await import("../src/state.js")).getIdentity()))!.installId, 100))).not.toContain("Printer");

    await deliver();
    const mirrors = mirrorsIn(globex);
    expect(mirrors.map((m) => m.summary)).toEqual(["Printer on fire"]);
    expect(mirrors[0]).toMatchObject({ project: "VEND", issuetype: "Task" });
    expect(textOf(mirrors[0]!.description)).toBe("Flames since 9am");
    expect(mirrors[0]!.properties["tb.mirror"]).toMatchObject({ ref: { key: shared.key } });
    // Relay mailbox is empty once everything is delivered.
    expect(await relayStore.listMail("", 1)).toEqual([]);
  });

  it("syncs comments both ways with author labels, and never restricted comments", async () => {
    const issue = [...acme.jira.issues.values()].find((i) => i.summary.startsWith("Printer on fire"))!;
    const mirror = mirrorsIn(globex)[0]!;

    await userComments(acme, issue, "We are on it", "Alice");
    await userComments(acme, issue, "Internal: blame Bob", "Alice", { type: "role", value: "Developers" });
    await deliver();
    expect(mirror.comments.map((c) => textOf(c.body))).toEqual(["Alice (Acme) We are on it"]);

    await userComments(globex, mirror, "Thanks, any ETA?", "Gina");
    await deliver();
    expect(issue.comments.map((c) => textOf(c.body))).toContain("Gina (Globex) Thanks, any ETA?");
    // The partner comment was written by the app, so it must not echo back.
    expect(mirror.comments).toHaveLength(2);
  });

  it("applies allowed status requests and reverts refused ones", async () => {
    const issue = [...acme.jira.issues.values()].find((i) => i.summary.startsWith("Printer on fire"))!;
    const mirror = mirrorsIn(globex)[0]!;

    // Not allowed from "Open": Acme refuses and Globex's mirror goes back.
    await userTransitions(globex, mirror, "In Progress");
    await deliver();
    expect(issue.status).toBe("Open");
    expect(mirror.status).toBe("Open");

    // Acme moves it to "Waiting for vendor"; now Globex may move it to "In Progress".
    await userTransitions(acme, issue, "Waiting for vendor");
    await deliver();
    expect(mirror.status).toBe("Waiting for vendor");
    await userTransitions(globex, mirror, "In Progress");
    await deliver();
    expect(issue.status).toBe("In Progress");
    expect(mirror.status).toBe("In Progress");
  });

  it("reverts edits to fields the partner may not change", async () => {
    const issue = [...acme.jira.issues.values()].find((i) => i.summary.startsWith("Printer on fire"))!;
    const mirror = mirrorsIn(globex)[0]!;
    await userEdits(globex, mirror, "summary", "Globex rewrote this");
    await deliver();
    expect(issue.summary).toBe("Printer on fire");
    expect(mirror.summary).toBe("Printer on fire");
  });

  it("recovers from a lost message by retransmitting", async () => {
    const issue = [...acme.jira.issues.values()].find((i) => i.summary.startsWith("Printer on fire"))!;
    const mirror = mirrorsIn(globex)[0]!;
    await userComments(acme, issue, "Lost in transit", "Alice");
    // Simulate loss: the relay drops everything queued and the ping never arrives.
    await relayStore.expireMail(Number.MAX_SAFE_INTEGER);
    pings.length = 0;
    expect(mirror.comments.map((c) => textOf(c.body))).not.toContain("Alice (Acme) Lost in transit");

    advance(2 * 60_000); // past the first retransmit delay
    await as(acme, () => onTick());
    await deliver();
    expect(mirror.comments.map((c) => textOf(c.body))).toContain("Alice (Acme) Lost in transit");
  });

  it("keeps messages through a Jira outage and applies them later, in order", async () => {
    const issue = [...acme.jira.issues.values()].find((i) => i.summary.startsWith("Printer on fire"))!;
    const mirror = mirrorsIn(globex)[0]!;
    globex.jira.failWrites = 1;
    await userComments(acme, issue, "first", "Alice");
    await userComments(acme, issue, "second", "Alice");
    await deliver();
    const texts = () => mirror.comments.map((c) => textOf(c.body));
    expect(texts()).not.toContain("Alice (Acme) first");

    await as(globex, () => onTick());
    const all = texts();
    expect(all.indexOf("Alice (Acme) first")).toBeGreaterThan(-1);
    expect(all.indexOf("Alice (Acme) second")).toBeGreaterThan(all.indexOf("Alice (Acme) first"));
  });

  it("reconciliation repairs changes that Jira never sent an event for", async () => {
    const issue = [...acme.jira.issues.values()].find((i) => i.summary.startsWith("Printer on fire"))!;
    const mirror = mirrorsIn(globex)[0]!;
    issue.summary = "Printer on fire (silently renamed)"; // no event fired

    advance(7 * 60 * 60_000);
    await as(globex, () => onTick()); // mirror holder sends its manifest; owner answers mismatches
    await deliver();
    expect(mirror.summary).toBe("Printer on fire (silently renamed)");
  });

  it("reconciliation shares opted-in tickets that were created without an event", async () => {
    acme.jira.createIssue("SUP", { summary: "Imported in bulk", labels: ["share-globex"] }); // no event
    advance(7 * 60 * 60_000);
    await as(acme, () => onTick());
    await deliver();
    expect(mirrorsIn(globex).map((m) => m.summary)).toContain("Imported in bulk");
  });

  it("deletes a comment on the partner side when its author deletes it", async () => {
    const issue = [...acme.jira.issues.values()].find((i) => i.summary.startsWith("Printer on fire"))!;
    const mirror = mirrorsIn(globex)[0]!;
    const c = await userComments(acme, issue, "Oops, wrong ticket", "Alice");
    await deliver();
    expect(mirror.comments.map((x) => textOf(x.body))).toContain("Alice (Acme) Oops, wrong ticket");

    issue.comments = issue.comments.filter((x) => x.id !== c.id);
    await as(acme, () => onIssueEvent({ eventType: "avi:jira:deleted:comment", issue: { id: issue.id, key: issue.key }, comment: { id: c.id } }));
    await deliver();
    expect(mirror.comments.map((x) => textOf(x.body))).not.toContain("Alice (Acme) Oops, wrong ticket");
  });

  it("does not send attachments while either side has them turned off", async () => {
    const issue = [...acme.jira.issues.values()].find((i) => i.summary.startsWith("Printer on fire"))!;
    await userAttaches(acme, issue, "early.pdf", "application/pdf", randomBytes(1000), "Alice");
    await deliver();
    expect(mirrorsIn(globex)[0]!.attachments).toHaveLength(0);
  });

  it("transfers a multi-chunk file intact once both sides allow attachments", async () => {
    await as(acme, () => pairing.savePolicy(connectionId, acmePolicy(true)));
    await as(globex, () => pairing.savePolicy(connectionId, globexPolicy(true)));
    await deliver();

    const issue = [...acme.jira.issues.values()].find((i) => i.summary.startsWith("Printer on fire"))!;
    const mirror = mirrorsIn(globex)[0]!;
    const bytes = randomBytes(250 * 1024); // 3 chunks
    await userAttaches(acme, issue, "wiring-diagram.pdf", "application/pdf", bytes, "Alice");
    await deliver();

    const got = mirror.attachments.find((a) => a.filename === "wiring-diagram.pdf")!;
    expect(got.mimeType).toBe("application/pdf");
    expect(Buffer.from(got.content).equals(Buffer.from(bytes))).toBe(true);
    // The file that was blocked earlier is picked up now too (it was never marked as sent).
    await as(acme, () => onIssueEvent({ eventType: "avi:jira:updated:issue", issue: { id: issue.id, key: issue.key } }));
    await deliver();
    expect(mirror.attachments.map((a) => a.filename).sort()).toEqual(["early.pdf", "wiring-diagram.pdf"]);
    // Received files are never echoed back, and no chunks or queued envelopes linger.
    expect(issue.attachments.map((a) => a.filename).sort()).toEqual(["early.pdf", "wiring-diagram.pdf"]);
    for (const t of [acme, globex]) {
      expect(keysIn(t, "a-chunk:")).toEqual([]);
      expect(keysIn(t, "outbox-entry:")).toEqual([]);
      expect(keysIn(t, "inbox-env:")).toEqual([]);
    }
  });

  it("applies the receiving side's attachment rules", async () => {
    const issue = [...acme.jira.issues.values()].find((i) => i.summary.startsWith("Printer on fire"))!;
    const mirror = mirrorsIn(globex)[0]!;
    // Acme lets Globex add PNGs only.
    await userAttaches(globex, mirror, "photo.png", "image/png", randomBytes(5000), "Gina");
    await userAttaches(globex, mirror, "tool.zip", "application/zip", randomBytes(5000), "Gina");
    await deliver();
    expect(issue.attachments.map((a) => a.filename)).toContain("photo.png");
    expect(issue.attachments.map((a) => a.filename)).not.toContain("tool.zip");
    // Acme's own outbound rules: an .exe is never offered.
    await userAttaches(acme, issue, "setup.exe", "application/x-msdownload", randomBytes(100), "Alice");
    await deliver();
    expect(mirror.attachments.map((a) => a.filename)).not.toContain("setup.exe");
  });

  it("turns inline images into a named reference", async () => {
    const description = {
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "See below:" }] },
        { type: "mediaSingle", content: [{ type: "media", attrs: { id: "abc-123", type: "file", collection: "", alt: "diagram.png" } }] },
      ],
    };
    await userCreates(acme, "SUP", { summary: "Has an inline image", labels: ["share-globex"], description });
    await deliver();
    const mirror = mirrorsIn(globex).find((m) => m.summary === "Has an inline image")!;
    expect(textOf(mirror.description)).toBe("See below: [diagram.png — see attachments]");
    expect(JSON.stringify(mirror.description)).not.toContain("abc-123");
  });

  it("admin page functions refuse non-admins", async () => {
    const call = (functionKey: string) => as(globex, () => handler({ call: { functionKey, payload: {} }, context: {} } as never));
    globex.jira.userIsAdmin = false;
    await expect(call("createInvite")).rejects.toThrow("Jira administrator permission required");
    await expect(call("listConnections")).rejects.toThrow("Jira administrator permission required");
    globex.jira.userIsAdmin = true;
    await expect(call("listConnections")).resolves.toHaveLength(1);
  });

  it("revocation stops the sync on both sides", async () => {
    await as(globex, () => pairing.revoke(connectionId));
    const conns = await as(acme, () => pairing.refreshConnections());
    expect(conns[0]!.status).toBe("revoked");

    const before = mirrorsIn(globex).length;
    await userCreates(acme, "SUP", { summary: "After revoke", labels: ["share-globex"] });
    await deliver();
    expect(mirrorsIn(globex)).toHaveLength(before);
  });
});
