import {
  acceptMac,
  type Bundle,
  capabilitySummary,
  confirmMac,
  createInvite as newInvite,
  deriveConnectionKeys,
  fingerprint,
  macEquals,
  parsePairingKey,
  type Policy,
  PolicySchema,
} from "@tb/protocol";
import { relay } from "./relay.js";
import {
  deleteConnectionKeys,
  deleteInvite,
  deletePairSecret,
  getConnection,
  getInvite,
  getPairSecret,
  type Identity,
  listConnections,
  type LocalConnection,
  saveConnection,
  setConnectionKeys,
  setInvite,
  setPairSecret,
} from "./state.js";
import { send } from "./sync.js";

const APP_VERSION = "0.1.0";

function myBundle(identity: Identity, siteName: string): Bundle {
  return {
    installId: identity.installId,
    signPub: identity.keys.signPub,
    dhPub: identity.keys.dhPub,
    siteName,
    appVersion: APP_VERSION,
  };
}

/** Step 1 (tenant A): returns what the admin sends to the partner. */
export async function createInvite() {
  const { client } = await relay();
  const invite = newInvite();
  await setInvite(invite);
  await client.createInvite(invite.inviteId, invite.expiresAt);
  return { connectionId: invite.inviteId, pairingKey: invite.pairingKey, expiresAt: invite.expiresAt };
}

/** Step 2 (tenant B): admin enters the partner's Connection ID and Pairing key. */
export async function acceptInvite(input: { connectionId: string; pairingKey: string; siteName: string }) {
  const { client, identity } = await relay();
  const secret = parsePairingKey(input.pairingKey);
  const bundle = myBundle(identity, input.siteName);
  const { connectionId } = await client.acceptInvite(input.connectionId, bundle, acceptMac(secret, input.connectionId, bundle));
  await setPairSecret(connectionId, { secret, inviteId: input.connectionId });
  await saveConnection({
    id: connectionId,
    role: "acceptor",
    inviteId: input.connectionId,
    status: "awaiting_confirm",
    createdAt: Date.now(),
  });
  return { connectionId };
}

/**
 * Reconciles local pairing state with the relay. Verifies every MAC locally, so a
 * relay that substitutes keys is detected here and the connection is dropped.
 */
export async function refreshConnections(): Promise<LocalConnection[]> {
  const { client, identity } = await relay();
  const remote = await client.listConnections();

  for (const rc of remote) {
    const local = await getConnection(rc.id);

    // Inviter: a partner accepted one of our invites.
    if (rc.a === identity.installId && rc.status === "pending" && !local) {
      const invite = await getInvite(rc.inviteId);
      if (!invite) continue;
      if (!macEquals(rc.macB, acceptMac(invite.pairingSecret, invite.inviteId, rc.bundleB))) {
        await client.reject(rc.id, "bad_mac");
        continue;
      }
      await saveConnection({
        id: rc.id,
        role: "inviter",
        inviteId: rc.inviteId,
        status: "pending_approval",
        peer: rc.b,
        peerBundle: rc.bundleB,
        peerFingerprint: fingerprint(rc.bundleB),
        createdAt: Date.now(),
      });
    }

    // Acceptor: the inviter approved.
    if (rc.b === identity.installId && rc.status === "active" && local?.status === "awaiting_confirm") {
      const ps = await getPairSecret(rc.id);
      if (!ps || !rc.bundleA || !rc.macA) continue;
      const mine = rc.bundleB;
      const ok =
        mine.installId === identity.installId &&
        mine.dhPub === identity.keys.dhPub &&
        macEquals(rc.macA, confirmMac(ps.secret, ps.inviteId, rc.id, rc.bundleA, mine));
      if (!ok) {
        // Keys were tampered with in transit: never trust this connection.
        await client.revoke(rc.id);
        await saveConnection({ ...local, status: "revoked" });
        await deletePairSecret(rc.id);
        continue;
      }
      await setConnectionKeys(
        deriveConnectionKeys({
          connectionId: rc.id,
          me: identity.installId,
          peer: rc.a,
          myDhPriv: identity.keys.dhPriv,
          peerDhPub: rc.bundleA.dhPub,
          pairingSecret: ps.secret,
        }),
      );
      await deletePairSecret(rc.id);
      await saveConnection({
        ...local,
        status: "active",
        peer: rc.a,
        peerBundle: rc.bundleA,
        peerFingerprint: fingerprint(rc.bundleA),
      });
    }

    // Partner revoked.
    if (rc.status === "revoked" && local && local.status !== "revoked") {
      await deleteConnectionKeys(rc.id);
      await saveConnection({ ...local, status: "revoked" });
    }
  }
  return listConnections();
}

/** Step 3 (tenant A): admin checked the partner's site and fingerprint, and approves. */
export async function approve(connectionId: string, siteName: string) {
  const { client, identity } = await relay();
  const local = await getConnection(connectionId);
  if (!local || local.status !== "pending_approval" || !local.peerBundle || !local.peer) {
    throw new Error("nothing to approve");
  }
  const invite = await getInvite(local.inviteId);
  if (!invite) throw new Error("invite expired");
  const bundle = myBundle(identity, siteName);
  await client.confirm(connectionId, bundle, confirmMac(invite.pairingSecret, invite.inviteId, connectionId, bundle, local.peerBundle));
  await setConnectionKeys(
    deriveConnectionKeys({
      connectionId,
      me: identity.installId,
      peer: local.peer,
      myDhPriv: identity.keys.dhPriv,
      peerDhPub: local.peerBundle.dhPub,
      pairingSecret: invite.pairingSecret,
    }),
  );
  await deleteInvite(invite.inviteId); // single use
  await saveConnection({ ...local, status: "active" });
}

export async function decline(connectionId: string) {
  const { client } = await relay();
  const local = await getConnection(connectionId);
  await client.reject(connectionId, "declined");
  if (local) await saveConnection({ ...local, status: "revoked" });
}

export async function revoke(connectionId: string) {
  const { client } = await relay();
  const local = await getConnection(connectionId);
  await client.revoke(connectionId);
  await deleteConnectionKeys(connectionId);
  if (local) await saveConnection({ ...local, status: "revoked" });
}

/** Saves this tenant's rules for a connection and tells the partner what it may do. */
export async function savePolicy(connectionId: string, input: unknown): Promise<Policy> {
  const policy = PolicySchema.parse(input);
  const local = await getConnection(connectionId);
  if (!local) throw new Error("unknown connection");
  const updated = { ...local, policy };
  await saveConnection(updated);
  if (updated.status === "active") await send(updated, capabilitySummary(policy));
  return policy;
}
