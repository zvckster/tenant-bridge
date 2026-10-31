import { equalBytes } from "@noble/ciphers/utils.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, randomBytes } from "@noble/hashes/utils.js";
import { z } from "zod";
import { canon, fromB64u, fromBase32Groups, toB64u, toBase32Groups, utf8 } from "./encoding.js";

export const PAIRING_SECRET_BYTES = 16;
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_FAILED_ACCEPTS = 5;

/** Public description of one side of a connection; authenticated by the pairing MACs. */
export const BundleSchema = z.object({
  installId: z.uuid(),
  signPub: z.string().min(1),
  dhPub: z.string().min(1),
  siteName: z.string().min(1).max(200),
  appVersion: z.string().min(1).max(40),
});
export type Bundle = z.infer<typeof BundleSchema>;

export interface Invite {
  inviteId: string; // sent to the relay
  pairingSecret: string; // base64url, stays on the inviting tenant until shown to the admin
  pairingKey: string; // human form of pairingSecret, e.g. "K7QD-M2XA-..."
  expiresAt: number;
}

export function createInvite(now = Date.now()): Invite {
  const secret = randomBytes(PAIRING_SECRET_BYTES);
  return {
    inviteId: crypto.randomUUID(),
    pairingSecret: toB64u(secret),
    pairingKey: toBase32Groups(secret),
    expiresAt: now + INVITE_TTL_MS,
  };
}

/** Turns what admin B typed into the raw secret (base64url). */
export function parsePairingKey(pairingKey: string): string {
  return toB64u(fromBase32Groups(pairingKey, PAIRING_SECRET_BYTES));
}

function pairingMacKey(pairingSecret: string, inviteId: string): Uint8Array {
  return hkdf(sha256, fromB64u(pairingSecret), utf8(inviteId), utf8("tb/v1/pair"), 32);
}

export function acceptMac(pairingSecret: string, inviteId: string, bundleB: Bundle): string {
  const k = pairingMacKey(pairingSecret, inviteId);
  return toB64u(hmac(sha256, k, concatBytes(utf8("tb/v1/accept"), canon(inviteId), canon(bundleB))));
}

export function confirmMac(
  pairingSecret: string,
  inviteId: string,
  connectionId: string,
  bundleA: Bundle,
  bundleB: Bundle,
): string {
  const k = pairingMacKey(pairingSecret, inviteId);
  return toB64u(
    hmac(
      sha256,
      k,
      concatBytes(utf8("tb/v1/confirm"), canon(connectionId), canon(bundleA), canon(bundleB)),
    ),
  );
}

export function macEquals(a: string, b: string): boolean {
  try {
    return equalBytes(fromB64u(a), fromB64u(b));
  } catch {
    return false;
  }
}
