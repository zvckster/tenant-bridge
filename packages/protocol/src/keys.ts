import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes } from "@noble/hashes/utils.js";
import { fromB64u, toB64u, utf8 } from "./encoding.js";

/** Long-term keys of one installation. Private halves never leave the tenant. */
export interface IdentityKeys {
  signPriv: string; // Ed25519, base64url
  signPub: string;
  dhPriv: string; // X25519, base64url
  dhPub: string;
}

export type PublicKeys = Pick<IdentityKeys, "signPub" | "dhPub">;

export function generateIdentity(): IdentityKeys {
  const signPriv = ed25519.utils.randomSecretKey();
  const dhPriv = x25519.utils.randomSecretKey();
  return {
    signPriv: toB64u(signPriv),
    signPub: toB64u(ed25519.getPublicKey(signPriv)),
    dhPriv: toB64u(dhPriv),
    dhPub: toB64u(x25519.getPublicKey(dhPriv)),
  };
}

/** 40 decimal digits in 8 groups, for admins to compare out of band. */
export function fingerprint(keys: PublicKeys): string {
  const digest = sha256(
    concatBytes(utf8("tb/v1/fp"), fromB64u(keys.signPub), fromB64u(keys.dhPub)),
  ).slice(0, 20);
  const groups: string[] = [];
  for (let i = 0; i < 20; i += 5) {
    // 5 bytes → 40-bit number → 2 groups of 5 digits
    let n = 0n;
    for (let j = 0; j < 5; j++) n = (n << 8n) | BigInt(digest[i + j]!);
    const digits = (n % 10_000_000_000n).toString().padStart(10, "0");
    groups.push(digits.slice(0, 5), digits.slice(5));
  }
  return groups.join(" ");
}

export function sign(message: Uint8Array, signPriv: string): string {
  return toB64u(ed25519.sign(message, fromB64u(signPriv)));
}

export function verifySignature(sig: string, message: Uint8Array, signPub: string): boolean {
  try {
    return ed25519.verify(fromB64u(sig), message, fromB64u(signPub));
  } catch {
    return false;
  }
}
