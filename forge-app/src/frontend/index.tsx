import React, { useEffect, useRef, useState } from "react";
import ForgeReconciler, {
  Badge,
  Box,
  Button,
  ButtonGroup,
  Code,
  EmptyState,
  Heading,
  HelperMessage,
  Inline,
  Label,
  LoadingButton,
  Lozenge,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalTransition,
  RadioGroup,
  SectionMessage,
  Stack,
  Strong,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  Textfield,
  xcss,
} from "@forge/react";
import { call, type Connection, errorText, formatBytes, type Overview } from "./api";
import { RulesEditor } from "./RulesEditor";

const REFRESH_MS = 5000;
type Ev = { target: { value?: unknown } };
const txt = (e: Ev) => String(e.target.value ?? "");

const card = xcss({
  padding: "space.200",
  borderRadius: "radius.medium",
  borderWidth: "border.width",
  borderStyle: "solid",
  borderColor: "color.border",
  backgroundColor: "elevation.surface.raised",
});

const STATUS: Record<Connection["status"], { label: string; look: "success" | "inprogress" | "new" | "removed" | "moved" }> = {
  active: { label: "Connected", look: "success" },
  pending_approval: { label: "Needs your approval", look: "moved" },
  awaiting_confirm: { label: "Waiting for partner to approve", look: "inprogress" },
  awaiting_partner: { label: "Waiting for partner", look: "inprogress" },
  revoked: { label: "Disconnected", look: "removed" },
};

function ConnectionCard(props: { c: Connection; myFingerprint: string; myName: string; onChanged: () => void }) {
  const { c } = props;
  const [editing, setEditing] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const partner = c.peerBundle?.siteName ?? "Partner";
  const status = STATUS[c.status];

  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
      props.onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Box xcss={card}>
      <Stack space="space.150">
        <Inline space="space.100" alignBlock="center" spread="space-between">
          <Inline space="space.100" alignBlock="center">
            <Heading size="small">{partner}</Heading>
            <Lozenge appearance={status.look} isBold={c.status === "pending_approval"}>{status.label}</Lozenge>
          </Inline>
          <Text>Since {new Date(c.createdAt).toLocaleDateString()}</Text>
        </Inline>

        {c.status === "active" && c.usage && (
          <Inline space="space.200" shouldWrap>
            <Text>
              This month: sent <Strong>{formatBytes(c.usage.sentBytes)}</Strong> <Badge>{c.usage.sentMessages}</Badge>, received{" "}
              <Strong>{formatBytes(c.usage.receivedBytes)}</Strong> <Badge>{c.usage.receivedMessages}</Badge>
            </Text>
          </Inline>
        )}

        {c.status === "active" && !c.policy && !editing && (
          <SectionMessage appearance="warning" title="Nothing is shared yet">
            <Text>Set the sharing rules to choose which tickets {partner} sees and what they may do.</Text>
          </SectionMessage>
        )}

        {c.status === "pending_approval" && (
          <SectionMessage appearance="information" title={`${partner} wants to connect`}>
            <Stack space="space.100">
              <Text>Before approving, check with them by phone or chat that the fingerprints match:</Text>
              <Text>Theirs (they see it as “your fingerprint”): <Code>{c.peerFingerprint}</Code></Text>
              <Text>Yours (they see it as “their fingerprint”): <Code>{props.myFingerprint}</Code></Text>
            </Stack>
          </SectionMessage>
        )}

        {c.status === "awaiting_confirm" && (
          <Text>The partner admin has to approve the connection on their side. This updates automatically.</Text>
        )}

        {editing ? (
          <RulesEditor
            connectionId={c.id}
            partnerName={partner}
            initial={c.policy}
            orgLabel={props.myName}
            onSaved={() => {
              setEditing(false);
              props.onChanged();
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <ButtonGroup>
            {c.status === "pending_approval" && (
              <>
                <LoadingButton appearance="primary" isLoading={busy === "approve"} onClick={() => act("approve", () => call("approve", { connectionId: c.id }))}>
                  Fingerprints match — approve
                </LoadingButton>
                <LoadingButton isLoading={busy === "decline"} onClick={() => act("decline", () => call("decline", { connectionId: c.id }))}>
                  Decline
                </LoadingButton>
              </>
            )}
            {c.status === "active" && (
              <>
                <Button appearance={c.policy ? "default" : "primary"} onClick={() => setEditing(true)}>
                  {c.policy ? "Edit sharing rules" : "Set sharing rules"}
                </Button>
                <Button appearance="subtle" onClick={() => setConfirmDisconnect(true)}>Disconnect</Button>
              </>
            )}
          </ButtonGroup>
        )}

        {error && <SectionMessage appearance="error"><Text>{error}</Text></SectionMessage>}
      </Stack>

      <ModalTransition>
        {confirmDisconnect && (
          <Modal onClose={() => setConfirmDisconnect(false)}>
            <ModalHeader>
              <ModalTitle appearance="danger">Disconnect from {partner}?</ModalTitle>
            </ModalHeader>
            <ModalBody>
              <Text>Syncing stops on both sides immediately and anything still in transit is dropped. Tickets already copied stay where they are. Reconnecting needs a new invite.</Text>
            </ModalBody>
            <ModalFooter>
              <Button appearance="subtle" onClick={() => setConfirmDisconnect(false)}>Cancel</Button>
              <LoadingButton
                appearance="danger"
                isLoading={busy === "revoke"}
                onClick={() => act("revoke", async () => { await call("revoke", { connectionId: c.id }); setConfirmDisconnect(false); })}
              >
                Disconnect
              </LoadingButton>
            </ModalFooter>
          </Modal>
        )}
      </ModalTransition>
    </Box>
  );
}

function ConnectPanel(props: { onConnected: () => void }) {
  const [invite, setInvite] = useState<{ code: string; expiresAt: number } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Stack space="space.300">
      <Box xcss={card}>
        <Stack space="space.150">
          <Heading size="small">Invite a partner</Heading>
          <Text>Create a one-time code and send it to the partner's Jira admin through a channel you trust (it works once, for 24 hours).</Text>
          {invite ? (
            <Stack space="space.100">
              <Label labelFor="invite-code">Invite code — select it and copy</Label>
              <Textfield id="invite-code" isReadOnly isMonospaced value={invite.code} />
              <HelperMessage>Valid until {new Date(invite.expiresAt).toLocaleString()}. When they connect, approve them under Connections.</HelperMessage>
              <Box>
                <Button appearance="subtle" onClick={() => setInvite(null)}>Done</Button>
              </Box>
            </Stack>
          ) : (
            <Box>
              <LoadingButton appearance="primary" isLoading={busy === "invite"} onClick={() => run("invite", async () => setInvite(await call("createInvite")))}>
                Create invite code
              </LoadingButton>
            </Box>
          )}
        </Stack>
      </Box>

      <Box xcss={card}>
        <Stack space="space.150">
          <Heading size="small">Join a partner</Heading>
          <Text>Paste the invite code a partner sent you.</Text>
          <Textfield placeholder="TB1-…" isMonospaced value={code} onChange={(e: Ev) => setCode(txt(e))} />
          {joined && (
            <SectionMessage appearance="success" title="Request sent">
              <Text>The partner admin now approves the connection. You'll see it under Connections.</Text>
            </SectionMessage>
          )}
          <Box>
            <LoadingButton
              appearance="primary"
              isDisabled={code.trim().length < 20}
              isLoading={busy === "join"}
              onClick={() =>
                run("join", async () => {
                  await call("acceptInvite", { code });
                  setCode("");
                  setJoined(true);
                  props.onConnected();
                })
              }
            >
              Connect
            </LoadingButton>
          </Box>
        </Stack>
      </Box>

      {error && <SectionMessage appearance="error"><Text>{error}</Text></SectionMessage>}
    </Stack>
  );
}

function SettingsPanel(props: { overview: Overview; onSaved: () => void }) {
  const { site, settings, myFingerprint } = props.overview;
  const [mode, setMode] = useState(settings.mode);
  const [anonName, setAnonName] = useState(settings.mode === "anonymous" ? settings.displayName : "");
  const [custom, setCustom] = useState(settings.mode === "custom" ? settings.displayName : "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const newName = async () => setAnonName((await call<{ name: string }>("suggestName")).name);
  useEffect(() => {
    if (mode === "anonymous" && !anonName) void newName();
  }, [mode]);

  const name = mode === "site" ? site : mode === "anonymous" ? anonName : custom.trim();

  return (
    <Box xcss={card}>
      <Stack space="space.200">
        <Heading size="small">How partners see this site</Heading>
        <RadioGroup
          name="mode"
          value={mode}
          onChange={(e: Ev) => setMode(txt(e) as typeof mode)}
          options={[
            { name: "mode", value: "site", label: `Site address (${site})` },
            { name: "mode", value: "anonymous", label: "Anonymous name — hides which company or site this is" },
            { name: "mode", value: "custom", label: "Custom name" },
          ]}
        />
        {mode === "anonymous" && (
          <Inline space="space.100" alignBlock="center">
            <Code>{anonName || "…"}</Code>
            <Button appearance="subtle" onClick={() => void newName()}>Generate another</Button>
          </Inline>
        )}
        {mode === "custom" && <Textfield placeholder="e.g. Acme Support" value={custom} onChange={(e: Ev) => setCustom(txt(e))} />}
        <HelperMessage>Used in new invites and connections. Existing partners keep the name they saw when connecting.</HelperMessage>
        <Box>
          <LoadingButton
            appearance="primary"
            isDisabled={!name}
            isLoading={busy}
            onClick={async () => {
              setBusy(true);
              setMessage(null);
              try {
                await call("saveSettings", { mode, displayName: name });
                setMessage({ ok: true, text: "Saved." });
                props.onSaved();
              } catch (e) {
                setMessage({ ok: false, text: errorText(e) });
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </LoadingButton>
        </Box>
        {message && <SectionMessage appearance={message.ok ? "success" : "error"}><Text>{message.text}</Text></SectionMessage>}
        <Stack space="space.050">
          <Label labelFor="fp">This site's fingerprint</Label>
          <Code>{myFingerprint}</Code>
          <HelperMessage>Partners compare this when approving a connection. It identifies this site's encryption keys.</HelperMessage>
        </Stack>
      </Stack>
    </Box>
  );
}

function App() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const loading = useRef(false);

  const refresh = async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      setOverview(await call<Overview>("overview"));
      setUpdatedAt(Date.now());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      loading.current = false;
    }
  };

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  if (!overview) {
    return error ? <SectionMessage appearance="error" title="Could not load"><Text>{error}</Text></SectionMessage> : <Text>Loading…</Text>;
  }

  const visible = overview.connections.filter((c) => c.status !== "revoked");
  const pending = visible.filter((c) => c.status === "pending_approval").length;

  return (
    <Stack space="space.200">
      <Inline space="space.100" alignBlock="center" spread="space-between">
        <Text>
          Connected as <Strong>{overview.settings.displayName}</Strong>
        </Text>
        <Text>{updatedAt ? `Updated ${new Date(updatedAt).toLocaleTimeString()}` : ""}</Text>
      </Inline>
      {error && <SectionMessage appearance="warning"><Text>Refresh failed: {error}</Text></SectionMessage>}

      <Tabs id="main" selected={tab} onChange={(i: number) => setTab(i)}>
        <TabList>
          <Tab>{pending ? `Connections (${pending} to approve)` : `Connections (${visible.length})`}</Tab>
          <Tab>Connect a partner</Tab>
          <Tab>Settings</Tab>
        </TabList>
        <TabPanel>
          <Box xcss={xcss({ paddingTop: "space.200", width: "100%" })}>
            {visible.length === 0 ? (
              <EmptyState
                header="No partners yet"
                description="Invite a partner, or join one with the invite code they sent you."
                primaryAction={<Button appearance="primary" onClick={() => setTab(1)}>Connect a partner</Button>}
              />
            ) : (
              <Stack space="space.200">
                {visible.map((c) => (
                  <ConnectionCard key={c.id} c={c} myFingerprint={overview.myFingerprint} myName={overview.settings.displayName} onChanged={() => void refresh()} />
                ))}
              </Stack>
            )}
          </Box>
        </TabPanel>
        <TabPanel>
          <Box xcss={xcss({ paddingTop: "space.200", width: "100%" })}>
            <ConnectPanel onConnected={() => void refresh()} />
          </Box>
        </TabPanel>
        <TabPanel>
          <Box xcss={xcss({ paddingTop: "space.200", width: "100%" })}>
            <SettingsPanel overview={overview} onSaved={() => void refresh()} />
          </Box>
        </TabPanel>
      </Tabs>
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
