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
const transport: Transport = async ({ method, path, body, headers }) => {
  const res = await fetch(`${relayUrl()}${path}`, { method, headers, body: body || undefined });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
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
