import React, { useEffect, useState } from "react";
import ForgeReconciler, {
  Button,
  Code,
  Heading,
  Inline,
  Lozenge,
  SectionMessage,
  Stack,
  Text,
  TextArea,
  Textfield,
} from "@forge/react";
import { invoke as bridgeInvoke } from "@forge/bridge";

// Without metadata, invoke resolves to the resolver's return value.
const invoke = <T = unknown,>(key: string, payload?: Record<string, unknown>) => bridgeInvoke(key, payload) as Promise<T>;

type Conn = {
  id: string;
  role: "inviter" | "acceptor";
  status: string;
  peerBundle?: { siteName: string };
  peerFingerprint?: string;
  policy?: unknown;
};

// Starting point for a new connection's rules. Phase 2 replaces this with a form.
const POLICY_TEMPLATE = {
  outbound: { spaces: ["SUP"], jql: "labels = share-partner", fields: ["description", "priority"], orgLabel: "Our company" },
  partner: { commentCreate: true, commentEditOwn: true, statusTransitions: [], editableFields: [] },
  inbound: { targetSpace: "VEND", issueType: "Task", statusMap: {} },
};

function App() {
  const [conns, setConns] = useState<Conn[]>([]);
  const [invite, setInvite] = useState<{ connectionId: string; pairingKey: string } | null>(null);
  const [joinId, setJoinId] = useState("");
  const [joinKey, setJoinKey] = useState("");
  const [siteName, setSiteName] = useState("");
  const [policyDrafts, setPolicyDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      setConns(await invoke<Conn[]>("listConnections"));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  useEffect(() => void run(async () => {}), []);

  return (
    <Stack space="space.300">
      {error && <SectionMessage appearance="error"><Text>{error}</Text></SectionMessage>}

      <Stack space="space.100">
        <Heading size="medium">This site</Heading>
        <Textfield placeholder="Site name shown to partners, e.g. acme.atlassian.net" value={siteName} onChange={(e) => setSiteName(e.target.value)} />
      </Stack>

      <Stack space="space.100">
        <Heading size="medium">Invite a partner</Heading>
        <Button onClick={() => run(async () => setInvite(await invoke<{ connectionId: string; pairingKey: string }>("createInvite")))}>Create invite</Button>
        {invite && (
          <SectionMessage appearance="information">
            <Text>Send both values to the partner admin through a channel you trust. Single use, valid 24 hours.</Text>
            <Text>Connection ID: <Code>{invite.connectionId}</Code></Text>
            <Text>Pairing key: <Code>{invite.pairingKey}</Code></Text>
          </SectionMessage>
        )}
      </Stack>

      <Stack space="space.100">
        <Heading size="medium">Join a partner's invite</Heading>
        <Textfield placeholder="Connection ID" value={joinId} onChange={(e) => setJoinId(e.target.value)} />
        <Textfield placeholder="Pairing key" value={joinKey} onChange={(e) => setJoinKey(e.target.value)} />
        <Button
          appearance="primary"
          isDisabled={!joinId || !joinKey || !siteName}
          onClick={() => run(() => invoke("acceptInvite", { connectionId: joinId.trim(), pairingKey: joinKey, siteName }))}
        >
          Connect
        </Button>
      </Stack>

      <Stack space="space.100">
        <Heading size="medium">Connections</Heading>
        <Button onClick={() => run(async () => {})}>Refresh</Button>
        {conns.map((c) => (
          <Stack key={c.id} space="space.100">
            <Inline space="space.100" alignBlock="center">
              <Text>{c.peerBundle?.siteName ?? "Waiting for partner"}</Text>
              <Lozenge appearance={c.status === "active" ? "success" : c.status === "revoked" ? "removed" : "inprogress"}>{c.status}</Lozenge>
            </Inline>
            {c.peerFingerprint && <Text>Fingerprint: <Code>{c.peerFingerprint}</Code></Text>}
            {c.status === "pending_approval" && (
              <Inline space="space.100">
                <Button appearance="primary" isDisabled={!siteName} onClick={() => run(() => invoke("approve", { connectionId: c.id, siteName }))}>Approve</Button>
                <Button onClick={() => run(() => invoke("decline", { connectionId: c.id }))}>Decline</Button>
              </Inline>
            )}
            {c.status === "active" && (
              <Stack space="space.100">
                <Text>Sharing rules (JSON)</Text>
                <TextArea
                  value={policyDrafts[c.id] ?? JSON.stringify(c.policy ?? POLICY_TEMPLATE, null, 2)}
                  onChange={(e) => setPolicyDrafts({ ...policyDrafts, [c.id]: e.target.value })}
                />
                <Inline space="space.100">
                  <Button
                    appearance="primary"
                    onClick={() => run(() => invoke("savePolicy", { connectionId: c.id, policy: JSON.parse(policyDrafts[c.id] ?? JSON.stringify(c.policy ?? POLICY_TEMPLATE)) }))}
                  >
                    Save rules
                  </Button>
                  <Button appearance="danger" onClick={() => run(() => invoke("revoke", { connectionId: c.id }))}>Disconnect</Button>
                </Inline>
              </Stack>
            )}
          </Stack>
        ))}
      </Stack>
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
