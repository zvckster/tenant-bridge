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

// ---- one-string invite codes: "TB1-XXXX-XXXX-..." carries the invite id, the pairing
// secret and a 2-byte checksum, so admins exchange a single value and typos are caught.

const INVITE_CODE_PREFIX = "TB1-";

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error("invalid invite id");
  return Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
}

function bytesToUuid(b: Uint8Array): string {
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const checksum = (b: Uint8Array) => sha256(concatBytes(utf8("tb/v1/invite-code"), b)).slice(0, 2);

export function encodeInviteCode(inviteId: string, pairingSecret: string): string {
  const body = concatBytes(uuidToBytes(inviteId), fromB64u(pairingSecret));
  return INVITE_CODE_PREFIX + toBase32Groups(concatBytes(body, checksum(body)));
}

export class InviteCodeError extends Error {}

/** Accepts the code as pasted (any case, extra spaces, missing prefix). */
export function decodeInviteCode(code: string): { inviteId: string; pairingSecret: string } {
  const cleaned = code.trim().toUpperCase().replace(/^TB1[-\s]*/, "");
  let raw: Uint8Array;
  try {
    raw = fromBase32Groups(cleaned, 16 + PAIRING_SECRET_BYTES + 2);
  } catch {
    throw new InviteCodeError("That doesn't look like an invite code. Check that the whole code was copied.");
  }
  const body = raw.subarray(0, 32);
  const sum = raw.subarray(32);
  const want = checksum(body);
  if (sum[0] !== want[0] || sum[1] !== want[1]) {
    throw new InviteCodeError("The invite code has a typo (checksum mismatch). Copy it again.");
  }
  return { inviteId: bytesToUuid(body.subarray(0, 16)), pairingSecret: toB64u(body.subarray(16)) };
}
