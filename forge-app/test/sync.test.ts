import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@forge/kvs", async () => (await import("./harness.js")).kvsMock);
vi.mock("@forge/api", async () => (await import("./harness.js")).apiMock);
vi.mock("@forge/events", async () => (await import("./harness.js")).eventsMock);

const H = await import("./harness.js");
const { onIssueEvent, onRelayPing, onTick, handler, jobs } = await import("../src/index.js");
const pairing = await import("../src/pairing.js");

const { as, addTenant, pings, relayStore, tenantByPing } = H;
type Tenant = ReturnType<typeof addTenant>;

const acme = addTenant("acme", "acme.atlassian.net");
const globex = addTenant("globex", "globex.atlassian.net");

const doc = (text: string) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const rawText = (adf: any): string => JSON.stringify(adf).match(/"text":"([^"]*)"/g)?.map((m) => m.slice(8, -1)).join(" ") ?? "";
const isGrey = (n: any) => (n.marks ?? []).some((m: any) => m.type === "textColor");
/** A synced comment as "Alice: text" (bold author lead; grey notes left out). Others: plain text. */
const textOf = (adf: any): string => {
  const paras = (adf?.content ?? []).filter((p: any) => !(p.content ?? []).every(isGrey));
  const first = paras[0]?.content?.[0];
  const body = (nodes: any[]) => nodes.filter((n) => !isGrey(n)).map((n) => n.text ?? "").join("").trim();
  if (first && (first.marks ?? []).some((m: any) => m.type === "strong")) {
    return `${first.text}: ${[body(paras[0].content.slice(1)), ...paras.slice(1).map((p: any) => body(p.content ?? []))].join(" ").trim()}`;
  }
  return rawText(adf);
};
/** The grey notes of a comment (crossing line, sent time). */
const notesOf = (adf: any): string[] => (adf?.content ?? []).flatMap((p: any) => (p.content ?? []).filter(isGrey).map((n: any) => n.text));

/** Runs queued Forge async events (the job worker) for one tenant. */
async function runJobs(t: Tenant) {
  while (t.jobs.length > 0) {
    const payload = t.jobs.shift()!;
    await as(t, () => jobs({ body: payload } as never));
  }
}

/** Delivers relay pings and runs queued jobs until both sides are quiet, as Forge would. */
async function deliver(maxSteps = 2000) {
  for (let i = 0; pings.length > 0 || H.allTenants().some((t) => t.jobs.length > 0); i++) {
    if (i >= maxSteps) throw new Error("sync did not settle (ping storm?)");
    const url = pings.shift();
    const t = url ? tenantByPing(url) : undefined;
    if (t) await as(t, () => onRelayPing());
    for (const x of H.allTenants()) await runJobs(x);
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
    attachments: { enabled: attachments, maxBytes: 10 * 1024 * 1024, mimeTypes: ["application/pdf", "image/png"] },
  },
  partner: {
    statusTransitions: [{ from: "Waiting for vendor", to: "In Progress" }],
    editableFields: ["priority"],
    attachmentAdd: { enabled: attachments, maxBytes: 10 * 1024 * 1024, mimeTypes: ["image/png"] },
  },
  inbound: { targetSpace: "ACMEIN", issueType: "Task" },
});
const globexPolicy = (attachments = false) => ({
  outbound: { spaces: ["GLX"], orgLabel: "Globex", attachments: { enabled: attachments, maxBytes: 10 * 1024 * 1024, mimeTypes: [] } },
  inbound: { targetSpace: "VEND", issueType: "Task", attachments: { enabled: attachments, maxBytes: 10 * 1024 * 1024, mimeTypes: [] } },
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
  expect(invite.code).toMatch(/^TB1-/); // one string carries id + key
  await as(globex, () => pairing.acceptInvite({ code: invite.code }));
  const pending = await as(acme, () => pairing.refreshConnections());
  expect(pending[0]).toMatchObject({ status: "pending_approval", peerBundle: { siteName: "globex.atlassian.net" } });
  connectionId = pending[0]!.id;
  await as(acme, () => pairing.approve(connectionId));
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
    expect(mirror.comments.map((c) => textOf(c.body))).toEqual(["Alice: We are on it"]);

    await userComments(globex, mirror, "Thanks, any ETA?", "Gina");
    await deliver();
    expect(issue.comments.map((c) => textOf(c.body))).toContain("Gina: Thanks, any ETA?");
    // The partner comment was written by the app, so it must not echo back.
    expect(mirror.comments).toHaveLength(2);
  });

  it("shows a synced comment like a native one: bold author, then the text", async () => {
    const issue = [...acme.jira.issues.values()].find((i) => i.summary.startsWith("Printer on fire"))!;
    const mirror = mirrorsIn(globex)[0]!;
    await userComments(acme, issue, "Format check", "Alice");
    await deliver();
    const last = mirror.comments[mirror.comments.length - 1]!;
    expect(last.body.content).toHaveLength(1); // one paragraph, no header
    expect(last.body.content[0].content[0]).toMatchObject({ text: "Alice", marks: [{ type: "strong" }] });
    expect(textOf(last.body)).toBe("Alice: Format check");
    expect(notesOf(last.body)).toEqual([]); // arrived promptly: no time note
  });

  it("notes the original time only when a comment arrives late", async () => {
    const issue = [...acme.jira.issues.values()].find((i) => i.summary.startsWith("Printer on fire"))!;
    const mirror = mirrorsIn(globex)[0]!;
    await userComments(acme, issue, "Sent during an outage", "Alice");
    advance(5 * 60_000); // delivered five minutes later
    await deliver();
    const last = mirror.comments[mirror.comments.length - 1]!;
    expect(textOf(last.body)).toBe("Alice: Sent during an outage");
    expect(notesOf(last.body)[0]).toMatch(/^ · sent \d{1,2} \w{3}, \d\d:\d\d UTC$/);
  });

  it("labels replies that crossed in transit, on both sides", async () => {
    const issue = [...acme.jira.issues.values()].find((i) => i.summary.startsWith("Printer on fire"))!;
    const mirror = mirrorsIn(globex)[0]!;
    await userComments(acme, issue, "Question one?", "Alice");
    await deliver();

    // Gina answers Q1 and Alice asks Q2 before either message is delivered.
    await userComments(globex, mirror, "Answer to one", "Gina");
    await userComments(acme, issue, "Question two?", "Alice");
    // An internal (restricted) note must never count as something the partner saw.
    await userComments(acme, issue, "internal note", "Alice", { type: "role", value: "Developers" });
    await deliver();

    const tail = (c: H.FakeComment[], n: number) => c.slice(-n).map((x) => rawText(x.body));
    // Acme sees Q1, Q2, (internal), then the answer: labelled as a reply to Q1.
    const answerOnAcme = tail(issue.comments, 1)[0]!;
    expect(answerOnAcme).toMatch(/^↩ Re: “Question one\?” Gina/);
    // Globex sees Q1, its answer, then Q2: labelled too, since Alice hadn't seen the answer.
    const q2OnGlobex = tail(mirror.comments, 1)[0]!;
    expect(q2OnGlobex).toMatch(/^↩ Re: “Question one\?” Alice/);

    // An ordinary reply that didn't cross anything carries no label.
    await userComments(globex, mirror, "Answer to two", "Gina");
    await deliver();
    expect(tail(issue.comments, 1)[0]).toMatch(/^Gina /);
  });

  it("catches up comments whose Jira event was late or never came, and still labels the crossing", async () => {
    const issue = [...acme.jira.issues.values()].find((i) => i.summary.startsWith("Printer on fire"))!;
    const mirror = mirrorsIn(globex)[0]!;
    await userComments(acme, issue, "Is it fixed?", "Alice");
    await deliver();

    // Gina answers, but Jira never tells the Globex app (event dropped).
    globex.jira.addComment(mirror, doc("Fixed this morning"), "Gina");
    // Meanwhile Alice follows up; it reaches Globex before the answer is ever sent.
    await userComments(acme, issue, "Any update?", "Alice");
    await deliver();
    const lastOnGlobex = rawText(mirror.comments[mirror.comments.length - 1]!.body);
    expect(lastOnGlobex).toMatch(/^↩ Re: “Is it fixed\?” Alice/); // crossed Gina's answer

    // The next scheduled tick finds and sends the answer that had no event.
    await as(globex, () => onTick());
    await deliver();
    expect(issue.comments.map((c) => textOf(c.body))).toContain("Gina: Fixed this morning");
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
    expect(mirror.comments.map((c) => textOf(c.body))).not.toContain("Alice: Lost in transit");

    advance(2 * 60_000); // past the first retransmit delay
    await as(acme, () => onTick());
    await deliver();
    expect(mirror.comments.map((c) => textOf(c.body))).toContain("Alice: Lost in transit");
  });

  it("keeps messages through a Jira outage and applies them later, in order", async () => {
    const issue = [...acme.jira.issues.values()].find((i) => i.summary.startsWith("Printer on fire"))!;
    const mirror = mirrorsIn(globex)[0]!;
    globex.jira.failWrites = 1;
    await userComments(acme, issue, "first", "Alice");
    await userComments(acme, issue, "second", "Alice");
    await deliver();
    const texts = () => mirror.comments.map((c) => textOf(c.body));
    expect(texts()).not.toContain("Alice: first");

    await as(globex, () => onTick());
    await deliver();
    const all = texts();
    expect(all.indexOf("Alice: first")).toBeGreaterThan(-1);
    expect(all.indexOf("Alice: second")).toBeGreaterThan(all.indexOf("Alice: first"));
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
    expect(mirror.comments.map((x) => textOf(x.body))).toContain("Alice: Oops, wrong ticket");

    issue.comments = issue.comments.filter((x) => x.id !== c.id);
    await as(acme, () => onIssueEvent({ eventType: "avi:jira:deleted:comment", issue: { id: issue.id, key: issue.key }, comment: { id: c.id } }));
    await deliver();
    expect(mirror.comments.map((x) => textOf(x.body))).not.toContain("Alice: Oops, wrong ticket");
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
    const bytes = randomBytes(5 * 1024 * 1024); // a "big" file: one encrypted blob via the relay
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
      expect(keysIn(t, "a-in:")).toEqual([]); // no half-received files left
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

  it("shows a partner's custom status the client's workflow lacks, and notes it once", async () => {
    const issue = [...acme.jira.issues.values()].find((i) => i.summary.startsWith("Printer on fire"))!;
    const mirror = mirrorsIn(globex)[0]!;
    acme.jira.statuses["Waiting for customer"] = "indeterminate"; // only Acme has it
    const notes = () => mirror.comments.filter((c) => textOf(c.body).startsWith("🔄 Partner status:")).map((c) => textOf(c.body));

    await userTransitions(acme, issue, "Waiting for customer");
    await deliver();
    expect(mirror.status).toBe("In Progress"); // closest status of the same category
    expect(notes()).toEqual(["🔄 Partner status:  Waiting for customer"]);

    // Further updates while still waiting don't repeat the note.
    await as(acme, () => onIssueEvent({ eventType: "avi:jira:updated:issue", issue: { id: issue.id, key: issue.key } }));
    await deliver();
    expect(notes()).toHaveLength(1);

    // A status both sides share syncs exactly, without a note.
    await userTransitions(acme, issue, "Done");
    await deliver();
    expect(mirror.status).toBe("Done");
    expect(notes()).toHaveLength(1);
    await userTransitions(acme, issue, "In Progress");
    await deliver();
  });

  it("a lock left behind by a timed-out run does not block syncing", async () => {
    const issue = [...acme.jira.issues.values()].find((i) => i.summary.startsWith("Printer on fire"))!;
    const mirror = mirrorsIn(globex)[0]!;
    // Forge KVS keeps expired keys around; simulate a dead holder's lock that never got deleted.
    acme.kv.set(`lock:outbox:${connectionId}`, { value: { owner: "dead-invocation", expiresAt: Date.now() - 1000 } });
    await userComments(acme, issue, "after a crash", "Alice");
    await deliver();
    expect(mirror.comments.map((c) => textOf(c.body))).toContain("Alice: after a crash");
  });

  it("rules saved before newer policy fields existed still work", async () => {
    const issue = [...acme.jira.issues.values()].find((i) => i.summary.startsWith("Printer on fire"))!;
    const mirror = mirrorsIn(globex)[0]!;
    // Simulate a policy stored by an older version: no outbound.labels.
    const key = `conn:${connectionId}`;
    const stored = acme.kv.get(key)!.value as { policy: { outbound: Record<string, unknown> } };
    delete stored.policy.outbound.labels;
    await userComments(acme, issue, "old rules", "Alice");
    await deliver();
    expect(mirror.comments.map((c) => textOf(c.body))).toContain("Alice: old rules");
  });

  it("admin page functions refuse non-admins", async () => {
    const call = (functionKey: string) => as(globex, () => handler({ call: { functionKey, payload: {} }, context: {} } as never));
    globex.jira.userIsAdmin = false;
    await expect(call("createInvite")).rejects.toThrow("Jira administrator permission required");
    await expect(call("overview")).rejects.toThrow("Jira administrator permission required");
    globex.jira.userIsAdmin = true;
    const ov = (await call("overview")) as { site: string; connections: Array<{ usage: { sentMessages: number } | null }> };
    expect(ov.site).toBe("globex.atlassian.net"); // filled in automatically
    expect(ov.connections).toHaveLength(1);
    expect(ov.connections[0]!.usage!.sentMessages).toBeGreaterThan(0); // relay metering per connection
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
