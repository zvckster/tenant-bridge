import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

export type Opt = { value: string; label: string; sub?: string };

export function Icon({ name, size = 18 }: { name: "bridge" | "plus" | "link" | "gear" | "copy" | "check" | "x" | "lock" | "users" | "send" | "inbox"; size?: number }) {
  const p: Record<string, ReactNode> = {
    bridge: <path d="M7 7a3 3 0 1 0 0 .01M17 17a3 3 0 1 0 0 .01M9.5 8.5l5 7M4 17h3m10-10h3" />,
    plus: <path d="M12 5v14M5 12h14" />,
    link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
    gear: <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.5 7.5 0 0 0-.1-1.3l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-2.2-1.3L14.3 3h-4l-.4 2.5a7.4 7.4 0 0 0-2.2 1.3l-2.4-1-2 3.4 2 1.6a7.5 7.5 0 0 0 0 2.6l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 2.2 1.3l.4 2.5h4l.4-2.5a7.4 7.4 0 0 0 2.2-1.3l2.4 1 2-3.4-2-1.6c.1-.4.1-.9.1-1.3z" />,
    copy: <path d="M9 9h10v10H9zM5 15V5h10" />,
    check: <path d="M5 12l5 5L20 7" />,
    x: <path d="M6 6l12 12M18 6L6 18" />,
    lock: <path d="M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3" />,
    users: <path d="M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm13 9v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8" />,
    send: <path d="M4 12l16-8-6 16-2-7z" />,
    inbox: <path d="M4 13l3-8h10l3 8v6H4zM4 13h5l1 2h4l1-2h5" />,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {p[name]}
    </svg>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`toggle ${on ? "on" : ""}`} onClick={() => onChange(!on)} />;
}

/** A labelled on/off row: title, optional description, switch on the right. */
export function SwitchRow(props: { title: string; desc?: string; on: boolean; onChange: (v: boolean) => void; children?: ReactNode }) {
  return (
    <div>
      <div className="switch">
        <div className="text">
          <span className="label">{props.title}</span>
          {props.desc && <span className="hint">{props.desc}</span>}
        </div>
        <Toggle on={props.on} onChange={props.onChange} label={props.title} />
      </div>
      {props.on && props.children && <div style={{ paddingBottom: 10 }}>{props.children}</div>}
    </div>
  );
}

/** Searchable multi-select with removable tags. `creatable` lets users add values not in the list. */
export function MultiSelect(props: { options: Opt[]; value: string[]; onChange: (v: string[]) => void; placeholder?: string; creatable?: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hl, setHl] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const byValue = useMemo(() => new Map(props.options.map((o) => [o.value, o])), [props.options]);
  const matches = props.options.filter((o) => !props.value.includes(o.value) && `${o.label} ${o.sub ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  const canCreate = props.creatable && q.trim() && !byValue.has(q.trim()) && !props.value.includes(q.trim());

  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const add = (v: string) => {
    props.onChange([...props.value, v]);
    setQ("");
    setHl(0);
  };

  return (
    <div className="multi" ref={ref}>
      <div className="multi-box" onClick={() => setOpen(true)}>
        {props.value.map((v) => (
          <span key={v} className="tag">
            {byValue.get(v)?.label ?? v}
            <button type="button" aria-label={`Remove ${v}`} onClick={(e) => { e.stopPropagation(); props.onChange(props.value.filter((x) => x !== v)); }}>×</button>
          </span>
        ))}
        <input
          value={q}
          placeholder={props.value.length ? "" : props.placeholder}
          onFocus={() => setOpen(true)}
          onChange={(e) => { setQ(e.target.value); setOpen(true); setHl(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setHl((h) => Math.min(h + 1, matches.length - 1));
            else if (e.key === "ArrowUp") setHl((h) => Math.max(h - 1, 0));
            else if (e.key === "Enter") { e.preventDefault(); if (matches[hl]) add(matches[hl]!.value); else if (canCreate) add(q.trim()); }
            else if (e.key === "Backspace" && !q && props.value.length) props.onChange(props.value.slice(0, -1));
            else if (e.key === "Escape") setOpen(false);
          }}
        />
      </div>
      {open && (matches.length > 0 || canCreate || q) && (
        <div className="menu">
          {matches.map((o, i) => (
            <div key={o.value} className={`menu-item ${i === hl ? "hl" : ""}`} onMouseDown={(e) => { e.preventDefault(); add(o.value); }}>
              <span>{o.label}</span>
              {o.sub && <span className="sub">{o.sub}</span>}
            </div>
          ))}
          {canCreate && (
            <div className="menu-item" onMouseDown={(e) => { e.preventDefault(); add(q.trim()); }}>
              <span>Add “{q.trim()}”</span>
            </div>
          )}
          {!matches.length && !canCreate && <div className="menu-empty">No matches</div>}
        </div>
      )}
    </div>
  );
}

export function Choice<T extends string>(props: { value: T; onChange: (v: T) => void; options: Array<{ value: T; title: string; desc?: string }> }) {
  return (
    <div className="seg">
      {props.options.map((o) => (
        <button type="button" key={o.value} className={`option ${props.value === o.value ? "sel" : ""}`} onClick={() => props.onChange(o.value)}>
          <span className="t">{o.title}</span>
          {o.desc && <span className="d">{o.desc}</span>}
        </button>
      ))}
    </div>
  );
}

export function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <span className="label">{props.label}</span>
      {props.children}
      {props.hint && <span className="hint">{props.hint}</span>}
    </div>
  );
}
