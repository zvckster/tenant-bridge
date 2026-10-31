import { fetch, webTrigger } from "@forge/api";
import { generateIdentity, RelayClient, type Transport } from "@tb/protocol";
import { getIdentity, type Identity, setIdentity } from "./state";

// Set with: forge variables set RELAY_URL https://relay.example.com
const relayUrl = () => {
  const url = process.env.RELAY_URL;
  if (!url) throw new Error("RELAY_URL is not configured");
  return url.replace(/\/$/, "");
};

// TODO(phase 2): switch to Forge Remote (invokeRemote) so each call carries a
// Forge Invocation Token the relay can verify (installation + license).
const transport: Transport = async ({ method, path, body, headers, binaryResponse }) => {
  const res = await fetch(`${relayUrl()}${path}`, {
    method,
    headers,
    // Forge fetch takes an ArrayBuffer for binary bodies; slice() gives one of exactly this length.
    body: typeof body === "string" ? body || undefined : (body.slice().buffer as ArrayBuffer),
  });
  if (binaryResponse && res.status === 200) {
    return { status: 200, json: null, bytes: new Uint8Array(await res.arrayBuffer()) };
  }
  const text = await res.text();
  try {
    return { status: res.status, json: text ? JSON.parse(text) : null };
  } catch {
    // A proxy or error page answered instead of the relay (e.g. relay down, wrong RELAY_URL).
    throw new Error(`Relay unreachable at ${relayUrl()} (HTTP ${res.status}, non-JSON response)`);
  }
};

/** Creates this installation's keys on first use and registers them with the relay. */
export async function ensureIdentity(): Promise<Identity> {
  let id = await getIdentity();
  if (!id) {
    id = { installId: crypto.randomUUID(), keys: generateIdentity(), registered: false };
    await setIdentity(id);
  }
  if (!id.registered) {
    const pingUrl = await webTrigger.getUrl("tb-relay-ping");
    await new RelayClient(transport, id.installId, id.keys.signPriv).register(id.keys, pingUrl);
    id = { ...id, registered: true };
    await setIdentity(id);
  }
  return id;
}

export async function relay(): Promise<{ client: RelayClient; identity: Identity }> {
  const identity = await ensureIdentity();
  return { client: new RelayClient(transport, identity.installId, identity.keys.signPriv), identity };
}
