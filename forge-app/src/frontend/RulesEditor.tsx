import React, { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  ButtonGroup,
  Checkbox,
  Heading,
  HelperMessage,
  Inline,
  Label,
  LoadingButton,
  RadioGroup,
  SectionMessage,
  Select,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  TextArea,
  Textfield,
  Toggle,
  xcss,
} from "@forge/react";
import {
  call,
  defaultPolicy,
  errorText,
  FILE_KINDS,
  kindsFromMimes,
  mimesFromKinds,
  type PolicyDraft,
  SIZE_OPTIONS,
  type Space,
} from "./api";

type Option = { label: string; value: string };
const opt = (v: string, label = v): Option => ({ label, value: v });
const values = (o: unknown): string[] => (Array.isArray(o) ? o.map((x: Option) => x.value) : o ? [(o as Option).value] : []);
const value = (o: unknown): string | undefined => (o ? (o as Option).value : undefined);

/** UI Kit events are serialised; `value` may be missing. */
type Ev = { target: { value?: unknown } };
const txt = (e: Ev) => String(e.target.value ?? "");

const SHAREABLE_FIELDS = [
  { value: "description", label: "Description" },
  { value: "priority", label: "Priority" },
  { value: "labels", label: "Labels" },
  { value: "dueDate", label: "Due date" },
];

const card = xcss({ padding: "space.200", borderRadius: "radius.medium", borderWidth: "border.width", borderStyle: "solid", borderColor: "color.border" });

/** Files rules: on/off, size limit and kinds of file. */
function FileRules(props: {
  title: string;
  rules: { enabled: boolean; maxBytes: number; mimeTypes: string[] };
  onChange: (r: { enabled: boolean; maxBytes: number; mimeTypes: string[] }) => void;
}) {
  const { rules, onChange } = props;
  return (
    <Stack space="space.100">
      <Toggle label={props.title} isChecked={rules.enabled} onChange={() => onChange({ ...rules, enabled: !rules.enabled })} />
      {rules.enabled && (
        <Inline space="space.200" shouldWrap>
          <Box xcss={xcss({ minWidth: "160px" })}>
            <Label labelFor="size">Max size</Label>
            <Select
              options={SIZE_OPTIONS.map((s) => ({ label: s.label, value: String(s.value) }))}
              value={SIZE_OPTIONS.filter((s) => s.value === rules.maxBytes).map((s) => ({ label: s.label, value: String(s.value) }))[0]}
              onChange={(o: unknown) => onChange({ ...rules, maxBytes: Number(value(o) ?? rules.maxBytes) })}
            />
          </Box>
          <Box xcss={xcss({ minWidth: "320px" })}>
            <Label labelFor="kinds">File types (none selected = any type)</Label>
            <Select
              isMulti
              options={FILE_KINDS.map((k) => opt(k.value, k.label))}
              value={FILE_KINDS.filter((k) => kindsFromMimes(rules.mimeTypes).includes(k.value)).map((k) => opt(k.value, k.label))}
              onChange={(o: unknown) => onChange({ ...rules, mimeTypes: mimesFromKinds(values(o)) })}
            />
          </Box>
        </Inline>
      )}
    </Stack>
  );
}

export function RulesEditor(props: {
  connectionId: string;
  partnerName: string;
  initial?: PolicyDraft;
  orgLabel: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [spaces, setSpaces] = useState<Space[] | null>(null);
  const [labels, setLabels] = useState<string[]>([]);
  const [customFields, setCustomFields] = useState<Array<{ id: string; name: string }>>([]);
  const [statuses, setStatuses] = useState<Record<string, string[]>>({});
  const [draft, setDraft] = useState<PolicyDraft | null>(props.initial ?? null);
  const [json, setJson] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [s, l, f] = await Promise.all([
          call<Space[]>("listSpaces"),
          call<string[]>("listLabels"),
          call<Array<{ id: string; name: string }>>("listCustomFields"),
        ]);
        setSpaces(s);
        setLabels(l);
        setCustomFields(f);
        setDraft((d) => d ?? defaultPolicy(props.orgLabel, s));
      } catch (e) {
        setError(errorText(e));
      }
    })();
  }, []);

  // Statuses of every space the rules mention, for the status pickers.
  const keysNeeded = useMemo(
    () => (draft ? [...new Set([...draft.outbound.spaces, draft.inbound.targetSpace].filter(Boolean))] : []),
    [draft?.outbound.spaces.join(","), draft?.inbound.targetSpace],
  );
  useEffect(() => {
    for (const key of keysNeeded) {
      if (statuses[key]) continue;
      call<Array<{ name: string }>>("spaceStatuses", { key })
        .then((list) => setStatuses((s) => ({ ...s, [key]: list.map((x) => x.name) })))
        .catch(() => setStatuses((s) => ({ ...s, [key]: [] })));
    }
  }, [keysNeeded.join(",")]);

  if (error && !draft) return <SectionMessage appearance="error"><Text>{error}</Text></SectionMessage>;
  if (!draft || !spaces) return <Text>Loading your spaces, labels and fields…</Text>;

  const set = (fn: (d: PolicyDraft) => PolicyDraft) => setDraft((d) => (d ? fn(structuredClone(d)) : d));
  const spaceOpts = spaces.map((s) => opt(s.key, `${s.name} (${s.key})`));
  const sharedSpaces = spaces.filter((s) => draft.outbound.spaces.includes(s.key));
  const typeOpts = [...new Set(sharedSpaces.flatMap((s) => s.issueTypes))].map((t) => opt(t));
  const outStatuses = [...new Set(draft.outbound.spaces.flatMap((k) => statuses[k] ?? []))];
  const target = spaces.find((s) => s.key === draft.inbound.targetSpace);
  const inStatuses = statuses[draft.inbound.targetSpace] ?? [];
  const editable = [
    opt("summary", "Summary"),
    ...SHAREABLE_FIELDS.filter((f) => draft.outbound.fields.includes(f.value)).map((f) => opt(f.value, f.label)),
    ...customFields.filter((f) => draft.outbound.customFields.includes(f.id)).map((f) => opt(f.id, f.name)),
  ];

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await call("savePolicy", { connectionId: props.connectionId, policy: draft });
      props.onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack space="space.200">
      <Heading size="small">Sharing rules with {props.partnerName}</Heading>
      <Tabs id={`rules-${props.connectionId}`} onChange={(i: number) => i === 3 && setJson(JSON.stringify(draft, null, 2))}>
        <TabList>
          <Tab>What I share</Tab>
          <Tab>What {props.partnerName} may do</Tab>
          <Tab>Their tickets here</Tab>
          <Tab>Advanced</Tab>
        </TabList>

        <TabPanel>
          <Box xcss={card}>
            <Stack space="space.200">
              <Stack space="space.050">
                <Label labelFor="spaces">Spaces to share from</Label>
                <Select isMulti options={spaceOpts} value={spaceOpts.filter((o) => draft.outbound.spaces.includes(o.value))} onChange={(o: unknown) => set((d) => ((d.outbound.spaces = values(o)), d))} />
              </Stack>
              <Stack space="space.050">
                <Label labelFor="types">Work types (none = all)</Label>
                <Select isMulti options={typeOpts} value={typeOpts.filter((o) => draft.outbound.issueTypes.includes(o.value))} onChange={(o: unknown) => set((d) => ((d.outbound.issueTypes = values(o)), d))} />
              </Stack>
              <Stack space="space.050">
                <Label labelFor="labels">Only tickets with one of these labels (none = every ticket in the spaces)</Label>
                <Select
                  isMulti
                  isSearchable
                  options={labels.map((l) => opt(l))}
                  value={draft.outbound.labels.map((l) => opt(l))}
                  onChange={(o: unknown) => set((d) => ((d.outbound.labels = values(o)), d))}
                />
                <HelperMessage>Tip: create a label such as "share-{props.partnerName.split(/[.\s]/)[0]}" and add it to tickets you want to share.</HelperMessage>
              </Stack>
              <Stack space="space.050">
                <Label labelFor="fields">Fields to include (summary, status and type are always shared)</Label>
                <Inline space="space.200" shouldWrap>
                  {SHAREABLE_FIELDS.map((f) => (
                    <Checkbox
                      key={f.value}
                      label={f.label}
                      isChecked={draft.outbound.fields.includes(f.value)}
                      onChange={() =>
                        set((d) => {
                          const has = d.outbound.fields.includes(f.value);
                          d.outbound.fields = has ? d.outbound.fields.filter((x) => x !== f.value) : [...d.outbound.fields, f.value];
                          return d;
                        })
                      }
                    />
                  ))}
                </Inline>
              </Stack>
              {customFields.length > 0 && (
                <Stack space="space.050">
                  <Label labelFor="custom">Custom fields to include</Label>
                  <Select
                    isMulti
                    isSearchable
                    options={customFields.map((f) => opt(f.id, f.name))}
                    value={customFields.filter((f) => draft.outbound.customFields.includes(f.id)).map((f) => opt(f.id, f.name))}
                    onChange={(o: unknown) => set((d) => ((d.outbound.customFields = values(o)), d))}
                  />
                </Stack>
              )}
              <Toggle
                label="Share public comments (internal comments are never shared)"
                isChecked={draft.outbound.comments === "public"}
                onChange={() => set((d) => ((d.outbound.comments = d.outbound.comments === "public" ? "off" : "public"), d))}
              />
              <FileRules title="Share attachments" rules={draft.outbound.attachments} onChange={(r) => set((d) => ((d.outbound.attachments = r), d))} />
              <Stack space="space.050">
                <Label labelFor="people">How my people appear to {props.partnerName}</Label>
                <RadioGroup
                  name="people"
                  options={[
                    { name: "people", value: "name", label: "Their name and our company name (e.g. “Ayman · Zvcks”)" },
                    { name: "people", value: "anonymous", label: "Only our company name (e.g. “Zvcks team”)" },
                  ]}
                  value={draft.outbound.people}
                  onChange={(e: Ev) => set((d) => ((d.outbound.people = txt(e) as "name" | "anonymous"), d))}
                />
              </Stack>
              <Stack space="space.050">
                <Label labelFor="org">Company name shown to {props.partnerName}</Label>
                <Textfield value={draft.outbound.orgLabel} onChange={(e: Ev) => set((d) => ((d.outbound.orgLabel = txt(e)), d))} />
              </Stack>
            </Stack>
          </Box>
        </TabPanel>

        <TabPanel>
          <Box xcss={card}>
            <Stack space="space.200">
              <Text>On the tickets I share, {props.partnerName} may:</Text>
              <Toggle label="Add comments" isChecked={draft.partner.commentCreate} onChange={() => set((d) => ((d.partner.commentCreate = !d.partner.commentCreate), d))} />
              <Toggle label="Edit their own comments" isChecked={draft.partner.commentEditOwn} onChange={() => set((d) => ((d.partner.commentEditOwn = !d.partner.commentEditOwn), d))} />
              <Toggle label="Delete their own comments" isChecked={draft.partner.commentDeleteOwn} onChange={() => set((d) => ((d.partner.commentDeleteOwn = !d.partner.commentDeleteOwn), d))} />
              <Stack space="space.100">
                <Label labelFor="transitions">Change the status (only these moves)</Label>
                {draft.partner.statusTransitions.length === 0 && <Text>No status changes allowed.</Text>}
                {draft.partner.statusTransitions.map((t, i) => (
                  <Inline key={i} space="space.100" alignBlock="center">
                    <Box xcss={xcss({ minWidth: "200px" })}>
                      <Select
                        options={[opt("", "From any status"), ...outStatuses.map((s) => opt(s))]}
                        value={opt(t.from ?? "", t.from ?? "From any status")}
                        onChange={(o: unknown) => set((d) => ((d.partner.statusTransitions[i]!.from = value(o) || undefined), d))}
                      />
                    </Box>
                    <Text>→</Text>
                    <Box xcss={xcss({ minWidth: "200px" })}>
                      <Select options={outStatuses.map((s) => opt(s))} value={t.to ? opt(t.to) : undefined} onChange={(o: unknown) => set((d) => ((d.partner.statusTransitions[i]!.to = value(o) ?? ""), d))} />
                    </Box>
                    <Button appearance="subtle" onClick={() => set((d) => (d.partner.statusTransitions.splice(i, 1), d))}>Remove</Button>
                  </Inline>
                ))}
                <Box>
                  <Button onClick={() => set((d) => (d.partner.statusTransitions.push({ to: outStatuses[0] ?? "" }), d))} isDisabled={outStatuses.length === 0}>
                    Allow a status change
                  </Button>
                </Box>
              </Stack>
              <Stack space="space.050">
                <Label labelFor="editable">Edit these fields</Label>
                <Select isMulti options={editable} value={editable.filter((o) => draft.partner.editableFields.includes(o.value))} onChange={(o: unknown) => set((d) => ((d.partner.editableFields = values(o)), d))} />
                <HelperMessage>Only fields you share can be offered. Refused edits are rolled back on their side.</HelperMessage>
              </Stack>
              <FileRules title="Add attachments" rules={draft.partner.attachmentAdd} onChange={(r) => set((d) => ((d.partner.attachmentAdd = r), d))} />
              <Toggle label="Create new tickets in my first shared space" isChecked={draft.partner.ticketCreate} onChange={() => set((d) => ((d.partner.ticketCreate = !d.partner.ticketCreate), d))} />
            </Stack>
          </Box>
        </TabPanel>

        <TabPanel>
          <Box xcss={card}>
            <Stack space="space.200">
              <Text>Tickets {props.partnerName} shares with me are created as:</Text>
              <Inline space="space.200" shouldWrap>
                <Box xcss={xcss({ minWidth: "260px" })}>
                  <Label labelFor="target">Space</Label>
                  <Select
                    options={spaceOpts}
                    value={spaceOpts.find((o) => o.value === draft.inbound.targetSpace)}
                    onChange={(o: unknown) =>
                      set((d) => {
                        d.inbound.targetSpace = value(o) ?? "";
                        const s = spaces.find((x) => x.key === d.inbound.targetSpace);
                        if (s && !s.issueTypes.includes(d.inbound.issueType)) d.inbound.issueType = s.issueTypes[0] ?? "Task";
                        return d;
                      })
                    }
                  />
                </Box>
                <Box xcss={xcss({ minWidth: "200px" })}>
                  <Label labelFor="itype">Work type</Label>
                  <Select
                    options={(target?.issueTypes ?? []).map((t) => opt(t))}
                    value={opt(draft.inbound.issueType)}
                    onChange={(o: unknown) => set((d) => ((d.inbound.issueType = value(o) ?? d.inbound.issueType), d))}
                  />
                </Box>
              </Inline>
              <Stack space="space.100">
                <Label labelFor="statusmap">Status mapping (optional)</Label>
                <HelperMessage>
                  Unmapped statuses use the same name, or the closest status of the same kind; the exact partner status is then noted on the ticket.
                </HelperMessage>
                {Object.entries(draft.inbound.statusMap).map(([theirs, mine], i) => (
                  <Inline key={i} space="space.100" alignBlock="center">
                    <Box xcss={xcss({ minWidth: "200px" })}>
                      <Textfield
                        placeholder="Their status, e.g. Waiting for customer"
                        value={theirs}
                        onChange={(e: Ev) =>
                          set((d) => {
                            const entries = Object.entries(d.inbound.statusMap);
                            entries[i] = [txt(e), mine];
                            d.inbound.statusMap = Object.fromEntries(entries);
                            return d;
                          })
                        }
                      />
                    </Box>
                    <Text>→</Text>
                    <Box xcss={xcss({ minWidth: "200px" })}>
                      <Select
                        options={inStatuses.map((s) => opt(s))}
                        value={mine ? opt(mine) : undefined}
                        onChange={(o: unknown) => set((d) => ((d.inbound.statusMap[theirs] = value(o) ?? ""), d))}
                      />
                    </Box>
                    <Button appearance="subtle" onClick={() => set((d) => (delete d.inbound.statusMap[theirs], d))}>Remove</Button>
                  </Inline>
                ))}
                <Box>
                  <Button onClick={() => set((d) => ((d.inbound.statusMap[""] = inStatuses[0] ?? ""), d))} isDisabled={"" in draft.inbound.statusMap}>
                    Add a mapping
                  </Button>
                </Box>
              </Stack>
              <FileRules title="Accept attachments on their tickets" rules={draft.inbound.attachments} onChange={(r) => set((d) => ((d.inbound.attachments = r), d))} />
            </Stack>
          </Box>
        </TabPanel>

        <TabPanel>
          <Box xcss={card}>
            <Stack space="space.200">
              <Stack space="space.050">
                <Label labelFor="jql">Extra JQL filter (optional, combined with the labels)</Label>
                <Textfield
                  placeholder='e.g. priority in (High, Highest)'
                  value={draft.outbound.jql ?? ""}
                  onChange={(e: Ev) => set((d) => ((d.outbound.jql = txt(e) || undefined), d))}
                />
              </Stack>
              <Stack space="space.050">
                <Label labelFor="json">Rules as JSON</Label>
                <TextArea value={json} onChange={(e: Ev) => setJson(txt(e))} />
                <Box>
                  <Button
                    onClick={() => {
                      try {
                        setDraft(JSON.parse(json) as PolicyDraft);
                        setError(null);
                      } catch {
                        setError("The JSON is not valid.");
                      }
                    }}
                  >
                    Apply JSON
                  </Button>
                </Box>
              </Stack>
            </Stack>
          </Box>
        </TabPanel>
      </Tabs>

      {error && <SectionMessage appearance="error"><Text>{error}</Text></SectionMessage>}
      <ButtonGroup>
        <LoadingButton appearance="primary" isLoading={saving} onClick={save}>Save rules</LoadingButton>
        <Button appearance="subtle" onClick={props.onCancel}>Cancel</Button>
      </ButtonGroup>
    </Stack>
  );
}
