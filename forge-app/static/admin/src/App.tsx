import { useCallback, useEffect, useRef, useState } from "react";
import { call, type Connection, errorText, formatBytes, hueOf, initials, type Overview, shortSite } from "./api";
import { RulesDrawer } from "./components/RulesDrawer";
import { Choice, Field, Icon } from "./components/ui";

const REFRESH_MS = 5000;
type Tab = "connections" | "connect" | "settings";
type Toast = { text: string; error?: boolean } | null;

const STATUS: Record<Connection["status"], { label: string; cls: string }> = {
  active: { label: "Connected", cls: "ok" },
  pending_approval: { label: "Needs approval", cls: "attn" },
  awaiting_confirm: { label: "Waiting for partner", cls: "wait" },
  awaiting_partner: { label: "Waiting for partner", cls: "wait" },
  revoked: { label: "Disconnected", cls: "" },
};

function ago(t: number) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

function Avatar({ name }: { name: string }) {
  const h = hueOf(name);
  return <div className="avatar" style={{ background: `linear-gradient(135deg, hsl(${h} 65% 52%), hsl(${(h + 40) % 360} 65% 45%))` }}>{initials(name)}</div>;
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false; // clipboard can be blocked inside Jira's iframe; the code stays selectable
  }
}

function RuleSummary({ c }: { c: Connection }) {
  const p = c.policy!;
  const chips: Array<[string, string]> = [
    ["Spaces", p.outbound.spaces.join(", ")],
    ...(p.outbound.labels.length ? [["Labels", p.outbound.labels.join(", ")] as [string, string]] : []),
    ["Comments", p.outbound.comments === "public" ? "public" : "off"],
    ["Files", p.outbound.attachments.enabled ? `up to ${formatBytes(p.outbound.attachments.maxBytes)}` : "off"],
    ["Their tickets →", p.inbound.targetSpace],
  ];
  return (
    <div className="chips">
      {chips.map(([k, v]) => <span key={k} className="chip">{k} <b>{v}</b></span>)}
    </div>
  );
}

function ConnectionCard(props: { c: Connection; myFingerprint: string; onEdit: () => void; onAction: (name: string, fn: () => Promise<unknown>, done: string) => void; onDisconnect: () => void }) {
  const { c } = props;
  const name = c.peerBundle?.siteName ?? "Pending partner";
  const st = STATUS[c.status];
  return (
    <div className="card stack">
      <div className="row spread wrap">
        <div className="row" style={{ minWidth: 0 }}>
          <Avatar name={name} />
          <div className="conn-title">
            <span className="name">{shortSite(name)}</span>
            <span className="faint">{c.role === "inviter" ? "You invited them" : "You joined their invite"} · {ago(c.createdAt)}</span>
          </div>
        </div>
        <span className={`pill ${st.cls}`}>{st.label}</span>
      </div>

      {c.status === "active" && c.usage && (
        <div className="meter">
          <span><Icon name="send" size={14} /> Sent <strong>{formatBytes(c.usage.sentBytes)}</strong> · {c.usage.sentMessages} messages</span>
          <span><Icon name="inbox" size={14} /> Received <strong>{formatBytes(c.usage.receivedBytes)}</strong> · {c.usage.receivedMessages} messages</span>
          <span className="faint">this month</span>
        </div>
      )}

      {c.status === "active" && (c.policy ? <RuleSummary c={c} /> : (
        <div className="callout warn">
          <div className="stack" style={{ gap: 2 }}>
            <strong>Nothing is shared yet</strong>
            <span className="muted">Choose which tickets {shortSite(name)} sees and what they can do.</span>
          </div>
        </div>
      ))}

      {c.status === "pending_approval" && (
        <div className="callout info">
          <div style={{ width: "100%" }}>
            <strong>{shortSite(name)} wants to connect.</strong>{" "}
            <span className="muted">Confirm by phone or chat that both fingerprints match before approving.</span>
            <div className="fp-compare">
              <div className="fp"><div className="faint">Theirs</div><div className="mono">{c.peerFingerprint}</div></div>
              <div className="fp"><div className="faint">Yours</div><div className="mono">{props.myFingerprint}</div></div>
            </div>
          </div>
        </div>
      )}

      {c.status === "awaiting_confirm" && <span className="muted">Their admin needs to approve. This page updates by itself.</span>}

      <div className="row wrap" style={{ gap: 8 }}>
        {c.status === "pending_approval" && (
          <>
            <button className="btn primary" onClick={() => props.onAction("approve", () => call("approve", { connectionId: c.id }), `Connected to ${shortSite(name)}`)}>
              <Icon name="check" size={16} /> Fingerprints match — approve
            </button>
            <button className="btn ghost" onClick={() => props.onAction("decline", () => call("decline", { connectionId: c.id }), "Declined")}>Decline</button>
          </>
        )}
        {c.status === "active" && (
          <>
            <button className={`btn ${c.policy ? "" : "primary"}`} onClick={props.onEdit}><Icon name="gear" size={16} /> {c.policy ? "Edit rules" : "Set up sharing"}</button>
            <button className="btn ghost" onClick={props.onDisconnect}>Disconnect</button>
          </>
        )}
      </div>
    </div>
  );
}

function ConnectView(props: { onDone: (msg: string) => void; toast: (t: Toast) => void }) {
  const [invite, setInvite] = useState<{ code: string; expiresAt: number } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const looksValid = /^\s*(TB1[-\s]*)?([A-Z2-7]{4}[-\s]*){8,}[A-Z2-7]{1,4}\s*$/i.test(code);

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    try {
      await fn();
    } catch (e) {
      props.toast({ text: errorText(e), error: true });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid2">
      <div className="card stack">
        <div className="row"><div className="logo" style={{ width: 32, height: 32, borderRadius: 8 }}><Icon name="link" size={16} /></div><h2>Invite a partner</h2></div>
        <span className="muted">Create a one-time code and send it to their Jira admin. It works once, for 24 hours.</span>
        {invite ? (
          <>
            <div className="code-box">
              <span className="mono">{invite.code}</span>
              <button className="btn sm" onClick={async () => props.toast({ text: (await copy(invite.code)) ? "Copied" : "Select the code and copy it" })}>
                <Icon name="copy" size={14} /> Copy
              </button>
            </div>
            <span className="faint">Expires {new Date(invite.expiresAt).toLocaleString()}. When they join, approve them under Connections.</span>
            <div><button className="btn ghost sm" onClick={() => setInvite(null)}>Create another</button></div>
          </>
        ) : (
          <div><button className="btn primary" disabled={busy === "invite"} onClick={() => run("invite", async () => setInvite(await call("createInvite")))}>
            {busy === "invite" ? "Creating…" : "Create invite code"}
          </button></div>
        )}
      </div>

      <div className="card stack">
        <div className="row"><div className="logo" style={{ width: 32, height: 32, borderRadius: 8 }}><Icon name="users" size={16} /></div><h2>Join a partner</h2></div>
        <span className="muted">Paste the invite code a partner sent you.</span>
        <input className="input mono" placeholder="TB1-XXXX-XXXX-…" value={code} onChange={(e) => setCode(e.target.value)} />
        <span className="faint">{code ? (looksValid ? "✓ Looks like a valid code" : "Keep pasting — the code is about 55 characters") : "Codes start with TB1-"}</span>
        <div>
          <button className="btn primary" disabled={!looksValid || busy === "join"} onClick={() => run("join", async () => {
            await call("acceptInvite", { code });
            setCode("");
            props.onDone("Request sent — their admin now approves it");
          })}>
            {busy === "join" ? "Connecting…" : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SettingsView(props: { o: Overview; onSaved: () => void; toast: (t: Toast) => void }) {
  const { site, settings, myFingerprint } = props.o;
  const [mode, setMode] = useState(settings.mode);
  const [anon, setAnon] = useState(settings.mode === "anonymous" ? settings.displayName : "");
  const [custom, setCustom] = useState(settings.mode === "custom" ? settings.displayName : "");
  const [busy, setBusy] = useState(false);
  const generate = async () => setAnon((await call<{ name: string }>("suggestName")).name);
  useEffect(() => { if (mode === "anonymous" && !anon) void generate(); }, [mode]);
  const name = mode === "site" ? site : mode === "anonymous" ? anon : custom.trim();

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="card stack">
        <h2>How partners see you</h2>
        <Choice
          value={mode}
          onChange={setMode}
          options={[
            { value: "site", title: "Site address", desc: site },
            { value: "anonymous", title: "Anonymous", desc: "A random four-word name that hides your company" },
            { value: "custom", title: "Custom name", desc: "Any name you choose" },
          ]}
        />
        {mode === "anonymous" && (
          <div className="code-box">
            <span className="mono">{anon || "…"}</span>
            <button className="btn sm" onClick={() => void generate()}>Shuffle</button>
          </div>
        )}
        {mode === "custom" && <input className="input" placeholder="e.g. Acme Support" value={custom} onChange={(e) => setCustom(e.target.value)} />}
        <div className="row spread wrap">
          <span className="faint">Partners will see <b>{name || "…"}</b>. Applies to new connections.</span>
          <button className="btn primary" disabled={!name || busy} onClick={async () => {
            setBusy(true);
            try {
              await call("saveSettings", { mode, displayName: name });
              props.toast({ text: "Saved" });
              props.onSaved();
            } catch (e) {
              props.toast({ text: errorText(e), error: true });
            } finally {
              setBusy(false);
            }
          }}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </div>
      <div className="card stack">
        <div className="row"><Icon name="lock" /><h2>Your fingerprint</h2></div>
        <span className="muted">Identifies this site's encryption keys. Partners compare it when approving a connection.</span>
        <div className="code-box"><span className="mono">{myFingerprint}</span></div>
      </div>
    </div>
  );
}

export function App() {
  const [o, setO] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("connections");
  const [editing, setEditing] = useState<Connection | null>(null);
  const [confirm, setConfirm] = useState<Connection | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const loading = useRef(false);

  const refresh = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      setO(await call<Overview>("overview"));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      loading.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const action = async (_name: string, fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      setToast({ text: done });
      void refresh();
    } catch (e) {
      setToast({ text: errorText(e), error: true });
    }
  };

  if (!o) {
    return (
      <div className="app"><div className="card empty">
        {error ? <><h2>Could not load</h2><p className="muted">{error}</p></> : <p className="muted">Loading…</p>}
      </div></div>
    );
  }

  const visible = o.connections.filter((c) => c.status !== "revoked");
  const active = visible.filter((c) => c.status === "active");
  const pending = visible.filter((c) => c.status === "pending_approval").length;
  const sent = active.reduce((n, c) => n + (c.usage?.sentBytes ?? 0), 0);
  const received = active.reduce((n, c) => n + (c.usage?.receivedBytes ?? 0), 0);

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <div className="logo"><Icon name="bridge" size={22} /></div>
          <div>
            <h1>Tenant Bridge</h1>
            <p>End-to-end encrypted ticket sync between Jira sites</p>
          </div>
        </div>
        <div className="row">
          <span className="live">Live</span>
          <span className="identity">You appear as <strong>{shortSite(o.settings.displayName)}</strong>
            <button className="btn ghost sm" onClick={() => setTab("settings")}>Change</button>
          </span>
        </div>
      </header>

      <nav className="tabs">
        <button className={`tab ${tab === "connections" ? "active" : ""}`} onClick={() => setTab("connections")}>
          Connections <span className={`count ${pending ? "alert" : ""}`}>{pending || visible.length}</span>
        </button>
        <button className={`tab ${tab === "connect" ? "active" : ""}`} onClick={() => setTab("connect")}><Icon name="plus" size={15} /> Connect a partner</button>
        <button className={`tab ${tab === "settings" ? "active" : ""}`} onClick={() => setTab("settings")}><Icon name="gear" size={15} /> Settings</button>
      </nav>

      {error && <div className="callout warn" style={{ marginBottom: 16 }}>Couldn't refresh: {error}</div>}

      {tab === "connections" && (
        <>
          <section className="stats">
            <div className="stat"><div className="label">Partners</div><div className="value">{active.length}</div><div className="sub">connected</div></div>
            <div className="stat"><div className="label">To approve</div><div className="value">{pending}</div><div className="sub">requests</div></div>
            <div className="stat"><div className="label">Sent</div><div className="value">{formatBytes(sent)}</div><div className="sub">this month</div></div>
            <div className="stat"><div className="label">Received</div><div className="value">{formatBytes(received)}</div><div className="sub">this month</div></div>
          </section>
          {visible.length === 0 ? (
            <div className="card empty">
              <div className="art"><Icon name="bridge" size={30} /></div>
              <h2>No partners yet</h2>
              <p className="muted">Invite a partner, or join one with the code they sent you.</p>
              <button className="btn primary" onClick={() => setTab("connect")}><Icon name="plus" size={16} /> Connect a partner</button>
            </div>
          ) : (
            <div className="stack" style={{ gap: 14 }}>
              {[...visible].sort((a, b) => Number(b.status === "pending_approval") - Number(a.status === "pending_approval")).map((c) => (
                <ConnectionCard key={c.id} c={c} myFingerprint={o.myFingerprint} onEdit={() => setEditing(c)} onAction={action} onDisconnect={() => setConfirm(c)} />
              ))}
            </div>
          )}
        </>
      )}

      {tab === "connect" && <ConnectView toast={setToast} onDone={(msg) => { setToast({ text: msg }); setTab("connections"); void refresh(); }} />}
      {tab === "settings" && <SettingsView o={o} toast={setToast} onSaved={() => void refresh()} />}

      {editing && (
        <RulesDrawer
          connectionId={editing.id}
          partner={shortSite(editing.peerBundle?.siteName ?? "Partner")}
          initial={editing.policy}
          orgLabel={shortSite(o.settings.displayName)}
          onClose={(saved) => { setEditing(null); if (saved) { setToast({ text: "Rules saved" }); void refresh(); } }}
        />
      )}

      {confirm && (
        <>
          <div className="scrim" onClick={() => setConfirm(null)} />
          <div className="modal" role="dialog">
            <h2>Disconnect from {shortSite(confirm.peerBundle?.siteName ?? "partner")}?</h2>
            <p className="muted" style={{ margin: 0 }}>Syncing stops on both sides immediately and anything still in transit is dropped. Tickets already copied stay. Reconnecting needs a new invite.</p>
            <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
              <button className="btn ghost" onClick={() => setConfirm(null)}>Cancel</button>
              <button className="btn danger" onClick={() => { const c = confirm; setConfirm(null); void action("revoke", () => call("revoke", { connectionId: c.id }), "Disconnected"); }}>Disconnect</button>
            </div>
          </div>
        </>
      )}

      {toast && <div className={`toast ${toast.error ? "error" : ""}`}>{toast.text}</div>}
    </div>
  );
}
