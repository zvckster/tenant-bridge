/**
 * Stand-in for @forge/bridge when previewing the page outside Jira (`vite --mode mock`).
 * Returns realistic sample data so the design can be reviewed and screenshotted.
 */
const MB = 1024 * 1024;
const policy = {
  outbound: {
    spaces: ["KAN"], issueTypes: [], labels: ["share-partner"], fields: ["description", "priority"], customFields: [],
    comments: "public", attachments: { enabled: true, maxBytes: 50 * MB, mimeTypes: ["image/png", "image/jpeg", "application/pdf"] },
    people: "name", orgLabel: "Zvcks",
  },
  partner: {
    commentCreate: true, commentEditOwn: true, commentDeleteOwn: true, reactionSet: true,
    statusTransitions: [{ from: "To Do", to: "In Progress" }], editableFields: ["priority"],
    attachmentAdd: { enabled: true, maxBytes: 25 * MB, mimeTypes: ["image/png", "image/jpeg"] }, ticketCreate: false,
  },
  inbound: { targetSpace: "SAM1", issueType: "Task", statusMap: { "Waiting for customer": "In Review" }, attachments: { enabled: true, maxBytes: 50 * MB, mimeTypes: [] } },
};
let settings = { displayName: "zvcks.atlassian.net", mode: "site" };
const data: Record<string, unknown> = {
  overview: () => ({
    site: "zvcks.atlassian.net",
    settings,
    myFingerprint: "48213 99021 03311 77450 12093 66402 91833 20457",
    connections: [
      { id: "c1", role: "inviter", status: "active", peerBundle: { siteName: "zvckster-team.atlassian.net" }, peerFingerprint: "11873 40291 88120 55301 70442 19934 60218 33017", policy, createdAt: Date.now() - 6 * 3600e3, usage: { sentBytes: 115 * MB, sentMessages: 210, receivedBytes: 461007, receivedMessages: 86 } },
      { id: "c2", role: "inviter", status: "pending_approval", peerBundle: { siteName: "amber-falcon-quiet-river" }, peerFingerprint: "90321 44187 20019 83321 55402 11290 76530 48821", createdAt: Date.now() - 300e3, usage: null },
      { id: "c3", role: "acceptor", status: "active", peerBundle: { siteName: "globex.atlassian.net" }, createdAt: Date.now() - 86400e3, usage: { sentBytes: 0, sentMessages: 2, receivedBytes: 2400, receivedMessages: 3 } },
    ],
  }),
  listSpaces: [
    { key: "KAN", name: "My Software Team", issueTypes: ["Task", "Story", "Bug", "Epic"] },
    { key: "SAM1", name: "(Example) Billing System Dev", issueTypes: ["Task", "Story", "Epic"] },
    { key: "SUP", name: "Customer Support", issueTypes: ["Request", "Incident"] },
  ],
  spaceStatuses: [{ name: "To Do" }, { name: "In Progress" }, { name: "In Review" }, { name: "Waiting for customer" }, { name: "Done" }],
  listLabels: ["share-partner", "urgent", "customer-x", "backend", "frontend", "billing"],
  listCustomFields: [{ id: "customfield_10020", name: "Sprint" }, { id: "customfield_10031", name: "Customer ID" }],
  createInvite: { code: "TB1-WXKU-5TFP-OVDN-BAB6-XNFX-YAUX-ZJBL-GWGU-GBLD-XAK4-GNCE-G4W2-5267-5FY", expiresAt: Date.now() + 24 * 3600e3 },
  suggestName: () => ({ name: ["amber-falcon-quiet-river", "cedar-lynx-bright-tide", "opal-heron-silent-dune"][Math.floor(Math.random() * 3)] }),
};

export async function invoke(key: string, payload?: Record<string, unknown>): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 120));
  if (key === "saveSettings" && payload) settings = payload as typeof settings;
  const v = data[key];
  return typeof v === "function" ? (v as () => unknown)() : (v ?? { ok: true });
}

export const view = {
  theme: {
    enable: async () => {
      const dark = new URLSearchParams(location.search).get("theme") === "dark";
      document.documentElement.setAttribute("data-color-mode", dark ? "dark" : "light");
    },
  },
};
