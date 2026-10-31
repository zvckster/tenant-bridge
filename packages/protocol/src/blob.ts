import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { concatBytes, randomBytes } from "@noble/hashes/utils.js";
import { fromB64u, toB64u, utf8 } from "./encoding.js";

/**
 * Attachments travel to the relay as one blob, encrypted with a fresh random key per
 * file. The key only ever travels inside an end-to-end encrypted attachment.offer, so
 * the relay stores bytes it cannot read. Layout: nonce (24 bytes) ‖ ciphertext+tag.
 * The connection and blob ids are bound as associated data, so a blob cannot be
 * replayed under another id.
 */
export const BLOB_HARD_LIMIT = 100 * 1024 * 1024;

const aad = (connectionId: string, blobId: string) => utf8(`tb/v1/blob|${connectionId}|${blobId}`);

export function sealBlob(connectionId: string, blobId: string, plain: Uint8Array): { key: string; data: Uint8Array } {
  const key = randomBytes(32);
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(key, nonce, aad(connectionId, blobId)).encrypt(plain);
  return { key: toB64u(key), data: concatBytes(nonce, ct) };
}

export class BlobDecryptError extends Error {}

export function openBlob(connectionId: string, blobId: string, key: string, data: Uint8Array): Uint8Array {
  if (data.length < 24 + 16) throw new BlobDecryptError("blob too short");
  try {
    return xchacha20poly1305(fromB64u(key), data.subarray(0, 24), aad(connectionId, blobId)).decrypt(data.subarray(24));
  } catch {
    throw new BlobDecryptError("blob authentication failed");
  }
}
