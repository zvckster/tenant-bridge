import { useEffect, useMemo, useState } from "react";
import { call, defaultPolicy, errorText, FILE_KINDS, kindsFromMimes, mimesFromKinds, type PolicyDraft, SIZE_OPTIONS, type Space } from "../api";
import { Choice, Field, Icon, MultiSelect, SwitchRow } from "./ui";

type Files = { enabled: boolean; maxBytes: number; mimeTypes: string[] };

const SHAREABLE_FIELDS = [
  { value: "description", label: "Description" },
  { value: "priority", label: "Priority" },
  { value: "labels", label: "Labels" },
  { value: "dueDate", label: "Due date" },
];

function FileRules({ files, onChange }: { files: Files; onChange: (f: Files) => void }) {
  return (
    <div className="grid2">
      <Field label="Largest file">
        <select className="input" value={files.maxBytes} onChange={(e) => onChange({ ...files, maxBytes: Number(e.target.value) })}>
          {SIZE_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </Field>
      <Field label="File types" hint="Leave empty to allow any type">
        <MultiSelect
          options={FILE_KINDS.map((k) => ({ value: k.value, label: k.label }))}
          value={kindsFromMimes(files.mimeTypes)}
          onChange={(v) => onChange({ ...files, mimeTypes: mimesFromKinds(v) })}
          placeholder="Any type"
        />
      </Field>
    </div>
  );
}

const SECTIONS = ["What you share", "What they can do", "Their tickets here", "Advanced"] as const;

export function RulesDrawer(props: { connectionId: string; partner: string; initial?: PolicyDraft; orgLabel: string; onClose: (saved: boolean) => void }) {
  const [spaces, setSpaces] = useState<Space[] | null>(null);
  const [labels, setLabels] = useState<string[]>([]);
  const [customFields, setCustomFields] = useState<Array<{ id: string; name: string }>>([]);
  const [statuses, setStatuses] = useState<Record<string, string[]>>({});
  const [draft, setDraft] = useState<PolicyDraft | null>(props.initial ? structuredClone(props.initial) : null);
  const [section, setSection] = useState<(typeof SECTIONS)[number]>("What you share");
  const [json, setJson] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([call<Space[]>("listSpaces"), call<string[]>("listLabels"), call<Array<{ id: string; name: string }>>("listCustomFields")])
      .then(([s, l, f]) => {
        setSpaces(s);
        setLabels(l);
        setCustomFields(f);
        setDraft((d) => d ?? defaultPolicy(props.orgLabel, s));
      })
      .catch((e) => setError(errorText(e)));
  }, []);

  const keys = useMemo(() => (draft ? [...new Set([...draft.outbound.spaces, draft.inbound.targetSpace].filter(Boolean))] : []), [draft?.outbound.spaces.join(), draft?.inbound.targetSpace]);
  useEffect(() => {
    for (const key of keys) {
      if (statuses[key]) continue;
      call<Array<{ name: string }>>("spaceStatuses", { key })
        .then((l) => setStatuses((s) => ({ ...s, [key]: l.map((x) => x.name) })))
        .catch(() => setStatuses((s) => ({ ...s, [key]: [] })));
    }
  }, [keys.join()]);

  const set = (fn: (d: PolicyDraft) => void) => setDraft((d) => { if (!d) return d; const c = structuredClone(d); fn(c); return c; });

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await call("savePolicy", { connectionId: props.connectionId, policy: draft });
      props.onClose(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const body = () => {
    if (!draft || !spaces) return <div className="muted">{error ?? "Loading your spaces, labels and fields…"}</div>;
    const spaceOpts = spaces.map((s) => ({ value: s.key, label: s.name, sub: s.key }));
    const shared = spaces.filter((s) => draft.outbound.spaces.includes(s.key));
    const types = [...new Set(shared.flatMap((s) => s.issueTypes))];
    const outStatuses = [...new Set(draft.outbound.spaces.flatMap((k) => statuses[k] ?? []))];
    const target = spaces.find((s) => s.key === draft.inbound.targetSpace);
    const inStatuses = statuses[draft.inbound.targetSpace] ?? [];
    const editable = [
      { value: "summary", label: "Summary" },
      ...SHAREABLE_FIELDS.filter((f) => draft.outbound.fields.includes(f.value)),
      ...customFields.filter((f) => draft.outbound.customFields.includes(f.id)).map((f) => ({ value: f.id, label: f.name })),
    ];

    switch (section) {
      case "What you share":
        return (
          <>
            <div className="card stack">
              <h3>Which tickets</h3>
              <Field label="Spaces">
                <MultiSelect options={spaceOpts} value={draft.outbound.spaces} onChange={(v) => set((d) => { d.outbound.spaces = v; })} placeholder="Choose spaces…" />
              </Field>
              <div className="grid2">
                <Field label="Work types" hint="Empty = all types">
                  <MultiSelect options={types.map((t) => ({ value: t, label: t }))} value={draft.outbound.issueTypes} onChange={(v) => set((d) => { d.outbound.issueTypes = v; })} placeholder="All types" />
                </Field>
                <Field label="Only with these labels" hint="Empty = every ticket in the spaces">
                  <MultiSelect creatable options={labels.map((l) => ({ value: l, label: l }))} value={draft.outbound.labels} onChange={(v) => set((d) => { d.outbound.labels = v; })} placeholder="e.g. share-partner" />
                </Field>
              </div>
            </div>
            <div className="card stack">
              <h3>What they see</h3>
              <span className="hint">Summary, status and work type are always shared.</span>
              <div className="chips">
                {SHAREABLE_FIELDS.map((f) => {
                  const on = draft.outbound.fields.includes(f.value);
                  return (
                    <button key={f.value} type="button" className={`option ${on ? "sel" : ""}`} style={{ padding: "8px 12px", flexDirection: "row", alignItems: "center" }}
                      onClick={() => set((d) => { d.outbound.fields = on ? d.outbound.fields.filter((x) => x !== f.value) : [...d.outbound.fields, f.value]; })}>
                      {on && <Icon name="check" size={14} />} {f.label}
                    </button>
                  );
                })}
              </div>
              {customFields.length > 0 && (
                <Field label="Custom fields">
                  <MultiSelect options={customFields.map((f) => ({ value: f.id, label: f.name }))} value={draft.outbound.customFields} onChange={(v) => set((d) => { d.outbound.customFields = v; })} placeholder="None" />
                </Field>
              )}
              <div>
                <SwitchRow title="Public comments" desc="Internal comments are never shared" on={draft.outbound.comments === "public"} onChange={(v) => set((d) => { d.outbound.comments = v ? "public" : "off"; })} />
                <SwitchRow title="Attachments" desc="Files are end-to-end encrypted in transit" on={draft.outbound.attachments.enabled} onChange={(v) => set((d) => { d.outbound.attachments.enabled = v; })}>
                  <FileRules files={draft.outbound.attachments} onChange={(f) => set((d) => { d.outbound.attachments = f; })} />
                </SwitchRow>
              </div>
            </div>
            <div className="card stack">
              <h3>How your people appear</h3>
              <Choice
                value={draft.outbound.people}
                onChange={(v) => set((d) => { d.outbound.people = v; })}
                options={[
                  { value: "name", title: "Person's name", desc: "e.g. “Ayman”" },
                  { value: "anonymous", title: "Company only", desc: `e.g. “${draft.outbound.orgLabel || "Your company"} team”` },
                ]}
              />
              <Field label="Company name">
                <input className="input" value={draft.outbound.orgLabel} onChange={(e) => set((d) => { d.outbound.orgLabel = e.target.value; })} />
              </Field>
            </div>
          </>
        );

      case "What they can do":
        return (
          <>
            <div className="card">
              <SwitchRow title="Comment" desc={`${props.partner} can add comments to your shared tickets`} on={draft.partner.commentCreate} onChange={(v) => set((d) => { d.partner.commentCreate = v; })} />
              <SwitchRow title="Edit their own comments" on={draft.partner.commentEditOwn} onChange={(v) => set((d) => { d.partner.commentEditOwn = v; })} />
              <SwitchRow title="Delete their own comments" on={draft.partner.commentDeleteOwn} onChange={(v) => set((d) => { d.partner.commentDeleteOwn = v; })} />
              <SwitchRow title="Add attachments" on={draft.partner.attachmentAdd.enabled} onChange={(v) => set((d) => { d.partner.attachmentAdd.enabled = v; })}>
                <FileRules files={draft.partner.attachmentAdd} onChange={(f) => set((d) => { d.partner.attachmentAdd = f; })} />
              </SwitchRow>
              <SwitchRow title="Create tickets" desc="In your first shared space" on={draft.partner.ticketCreate} onChange={(v) => set((d) => { d.partner.ticketCreate = v; })} />
            </div>
            <div className="card stack">
              <div className="row spread">
                <div>
                  <h3>Status changes</h3>
                  <span className="hint">Only these moves are allowed. Anything else is refused and rolled back on their side.</span>
                </div>
                <button className="btn sm" disabled={!outStatuses.length} onClick={() => set((d) => { d.partner.statusTransitions.push({ to: outStatuses[0] ?? "" }); })}>
                  <Icon name="plus" size={14} /> Add
                </button>
              </div>
              {draft.partner.statusTransitions.length === 0 && <span className="muted">No status changes allowed.</span>}
              {draft.partner.statusTransitions.map((t, i) => (
                <div key={i} className="transition-row">
                  <select className="input" value={t.from ?? ""} onChange={(e) => set((d) => { d.partner.statusTransitions[i]!.from = e.target.value || undefined; })}>
                    <option value="">From any status</option>
                    {outStatuses.map((s) => <option key={s}>{s}</option>)}
                  </select>
                  <span className="muted">→</span>
                  <select className="input" value={t.to} onChange={(e) => set((d) => { d.partner.statusTransitions[i]!.to = e.target.value; })}>
                    {outStatuses.map((s) => <option key={s}>{s}</option>)}
                  </select>
                  <button className="btn ghost sm" aria-label="Remove" onClick={() => set((d) => { d.partner.statusTransitions.splice(i, 1); })}><Icon name="x" size={14} /></button>
                </div>
              ))}
            </div>
            <div className="card stack">
              <Field label="Fields they can edit" hint="Only fields you share can be offered">
                <MultiSelect options={editable} value={draft.partner.editableFields} onChange={(v) => set((d) => { d.partner.editableFields = v; })} placeholder="None" />
              </Field>
            </div>
          </>
        );

      case "Their tickets here":
        return (
          <>
            <div className="card stack">
              <h3>Where {props.partner}'s tickets appear</h3>
              <div className="grid2">
                <Field label="Space">
                  <select className="input" value={draft.inbound.targetSpace} onChange={(e) => set((d) => {
                    d.inbound.targetSpace = e.target.value;
                    const s = spaces.find((x) => x.key === e.target.value);
                    if (s && !s.issueTypes.includes(d.inbound.issueType)) d.inbound.issueType = s.issueTypes[0] ?? "Task";
                  })}>
                    {spaces.map((s) => <option key={s.key} value={s.key}>{s.name} ({s.key})</option>)}
                  </select>
                </Field>
                <Field label="Work type">
                  <select className="input" value={draft.inbound.issueType} onChange={(e) => set((d) => { d.inbound.issueType = e.target.value; })}>
                    {(target?.issueTypes ?? []).map((t) => <option key={t}>{t}</option>)}
                  </select>
                </Field>
              </div>
            </div>
            <div className="card stack">
              <div className="row spread">
                <div>
                  <h3>Status mapping</h3>
                  <span className="hint">Unmapped statuses use the same name or the closest of the same kind; the exact one is noted on the ticket.</span>
                </div>
                <button className="btn sm" disabled={"" in draft.inbound.statusMap} onClick={() => set((d) => { d.inbound.statusMap[""] = inStatuses[0] ?? ""; })}>
                  <Icon name="plus" size={14} /> Add
                </button>
              </div>
              {Object.entries(draft.inbound.statusMap).map(([theirs, mine], i) => (
                <div key={i} className="transition-row">
                  <input className="input" placeholder="Their status, e.g. Waiting for customer" value={theirs} onChange={(e) => set((d) => {
                    const entries = Object.entries(d.inbound.statusMap);
                    entries[i] = [e.target.value, mine];
                    d.inbound.statusMap = Object.fromEntries(entries);
                  })} />
                  <span className="muted">→</span>
                  <select className="input" value={mine} onChange={(e) => set((d) => { d.inbound.statusMap[theirs] = e.target.value; })}>
                    {inStatuses.map((s) => <option key={s}>{s}</option>)}
                  </select>
                  <button className="btn ghost sm" aria-label="Remove" onClick={() => set((d) => { delete d.inbound.statusMap[theirs]; })}><Icon name="x" size={14} /></button>
                </div>
              ))}
            </div>
            <div className="card">
              <SwitchRow title="Accept their attachments" on={draft.inbound.attachments.enabled} onChange={(v) => set((d) => { d.inbound.attachments.enabled = v; })}>
                <FileRules files={draft.inbound.attachments} onChange={(f) => set((d) => { d.inbound.attachments = f; })} />
              </SwitchRow>
            </div>
          </>
        );

      case "Advanced":
        return (
          <div className="card stack">
            <Field label="Extra JQL filter" hint="Combined with the labels above, e.g. priority in (High, Highest)">
              <input className="input mono" value={draft.outbound.jql ?? ""} onChange={(e) => set((d) => { d.outbound.jql = e.target.value || undefined; })} />
            </Field>
            <Field label="Rules as JSON">
              <textarea className="input mono" value={json || JSON.stringify(draft, null, 2)} onChange={(e) => setJson(e.target.value)} />
            </Field>
            <div>
              <button className="btn sm" onClick={() => { try { setDraft(JSON.parse(json || JSON.stringify(draft))); setJson(""); setError(null); } catch { setError("The JSON is not valid."); } }}>
                Apply JSON
              </button>
            </div>
          </div>
        );
    }
  };

  return (
    <>
      <div className="scrim" onClick={() => props.onClose(false)} />
      <aside className="drawer" role="dialog" aria-label="Sharing rules">
        <div className="drawer-head">
          <div>
            <h2>Sharing rules</h2>
            <span className="muted">with {props.partner}</span>
          </div>
          <button className="btn ghost" aria-label="Close" onClick={() => props.onClose(false)}><Icon name="x" /></button>
        </div>
        <nav className="section-nav">
          {SECTIONS.map((s) => <button key={s} className={s === section ? "active" : ""} onClick={() => setSection(s)}>{s}</button>)}
        </nav>
        <div className="drawer-body">
          {body()}
          {error && draft && <div className="callout danger">{error}</div>}
        </div>
        <div className="drawer-foot">
          <button className="btn ghost" onClick={() => props.onClose(false)}>Cancel</button>
          <button className="btn primary" disabled={saving || !draft} onClick={save}>{saving ? "Saving…" : "Save rules"}</button>
        </div>
      </aside>
    </>
  );
}
