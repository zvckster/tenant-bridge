import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, randomBytes } from "@noble/hashes/utils.js";
import { z } from "zod";
import { canon, canonicalJson, fromB64u, toB64u, utf8 } from "./encoding.js";

export const MAX_ENVELOPE_BYTES = 1024 * 1024;

/**
 * Channels: "d" (data) is ordered, retransmitted until acknowledged.
 * "c" (control: ack/nack) is unordered, best effort and never acknowledged itself,
 * which keeps acks from triggering acks. Control payloads are cumulative, so loss is harmless.
 */
export const ChannelSchema = z.enum(["d", "c"]);
export type Channel = z.infer<typeof ChannelSchema>;

/** What the relay sees. Everything else is inside `ct`. */
export const EnvelopeSchema = z.object({
  v: z.literal(1),
  connectionId: z.uuid(),
  sender: z.uuid(),
  ch: ChannelSchema,
  seq: z.number().int().positive(), // per (connection, sender, channel)
  epoch: z.number().int().nonnegative(),
  nonce: z.string().length(32), // 24 bytes base64url
  ct: z.string().min(1),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;
export type EnvelopeHeader = Omit<Envelope, "nonce" | "ct">;

/** Per-connection key material, derived once after pairing and kept in secret storage. */
export interface ConnectionKeys {
  connectionId: string;
  me: string; // my installId
  peer: string; // partner installId
  root: string; // base64url
}

export function deriveConnectionKeys(params: {
  connectionId: string;
  me: string;
  peer: string;
  myDhPriv: string;
  peerDhPub: string;
  pairingSecret: string;
}): ConnectionKeys {
  const shared = x25519.getSharedSecret(fromB64u(params.myDhPriv), fromB64u(params.peerDhPub));
  const root = hkdf(
    sha256,
    concatBytes(shared, fromB64u(params.pairingSecret)),
    utf8(params.connectionId),
    utf8("tb/v1/root"),
    32,
  );
  return { connectionId: params.connectionId, me: params.me, peer: params.peer, root: toB64u(root) };
}

function messageKey(keys: ConnectionKeys, epoch: number, sender: string): Uint8Array {
  return hkdf(
    sha256,
    fromB64u(keys.root),
    utf8(keys.connectionId),
    utf8(`tb/v1/msg|${epoch}|${sender}`),
    32,
  );
}

function headerAad(h: EnvelopeHeader): Uint8Array {
  return canon({ v: h.v, connectionId: h.connectionId, sender: h.sender, ch: h.ch, seq: h.seq, epoch: h.epoch });
}

export function seal(
  keys: ConnectionKeys,
  ch: Channel,
  seq: number,
  epoch: number,
  payload: unknown,
): Envelope {
  const header: EnvelopeHeader = { v: 1, connectionId: keys.connectionId, sender: keys.me, ch, seq, epoch };
  const nonce = randomBytes(24);
  const cipher = xchacha20poly1305(messageKey(keys, epoch, keys.me), nonce, headerAad(header));
  const ct = cipher.encrypt(utf8(canonicalJson(payload)));
  const env: Envelope = { ...header, nonce: toB64u(nonce), ct: toB64u(ct) };
  if (envelopeSize(env) > MAX_ENVELOPE_BYTES) throw new Error("payload too large for one envelope");
  return env;
}

export class DecryptError extends Error {}

/** Decrypts a partner envelope. Throws DecryptError on any tampering or misrouting. */
export function open(keys: ConnectionKeys, env: Envelope, acceptedEpochs: number[]): unknown {
  if (env.connectionId !== keys.connectionId) throw new DecryptError("wrong connection");
  if (env.sender !== keys.peer) throw new DecryptError("unexpected sender");
  if (!acceptedEpochs.includes(env.epoch)) throw new DecryptError("epoch not accepted");
  try {
    const cipher = xchacha20poly1305(
      messageKey(keys, env.epoch, env.sender),
      fromB64u(env.nonce),
      headerAad(env),
    );
    const plain = cipher.decrypt(fromB64u(env.ct));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new DecryptError("authentication failed");
  }
}

export function envelopeSize(env: Envelope): number {
  return utf8(JSON.stringify(env)).length;
}
