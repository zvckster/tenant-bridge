import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { toB64u, utf8 } from "./encoding.js";
import { sign, verifySignature } from "./keys.js";

export const REQUEST_WINDOW_MS = 5 * 60 * 1000;

export const AUTH_HEADERS = {
  install: "x-tb-install",
  ts: "x-tb-ts",
  nonce: "x-tb-nonce",
  sig: "x-tb-sig",
} as const;

/** A request body: JSON text, or raw bytes for blob uploads. */
export type RequestBody = string | Uint8Array;

function signingString(method: string, path: string, ts: string, nonce: string, body: RequestBody): Uint8Array {
  const bodyHash = bytesToHex(sha256(typeof body === "string" ? utf8(body) : body));
  return utf8(["tb/v1/req", method.toUpperCase(), path, ts, nonce, bodyHash].join("\n"));
}

/** Headers an installation attaches to every relay request. `path` includes the query string. */
export function signRequest(params: {
  installId: string;
  signPriv: string;
  method: string;
  path: string;
  body: RequestBody;
  now?: number;
}): Record<string, string> {
  const ts = String(params.now ?? Date.now());
  const nonce = toB64u(randomBytes(16));
  return {
    [AUTH_HEADERS.install]: params.installId,
    [AUTH_HEADERS.ts]: ts,
    [AUTH_HEADERS.nonce]: nonce,
    [AUTH_HEADERS.sig]: sign(signingString(params.method, params.path, ts, nonce, params.body), params.signPriv),
  };
}

export type RequestCheck = { ok: true; nonce: string } | { ok: false; reason: string };

/** Signature and freshness check. The caller must also reject nonces it has seen before. */
export function verifyRequest(params: {
  headers: Record<string, string | undefined>;
  signPub: string;
  method: string;
  path: string;
  body: RequestBody;
  now?: number;
}): RequestCheck {
  const h = params.headers;
  const ts = h[AUTH_HEADERS.ts];
  const nonce = h[AUTH_HEADERS.nonce];
  const sig = h[AUTH_HEADERS.sig];
  if (!ts || !nonce || !sig) return { ok: false, reason: "missing_auth_headers" };
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs((params.now ?? Date.now()) - t) > REQUEST_WINDOW_MS) {
    return { ok: false, reason: "stale_request" };
  }
  const msg = signingString(params.method, params.path, ts, nonce, params.body);
  return verifySignature(sig, msg, params.signPub) ? { ok: true, nonce } : { ok: false, reason: "bad_signature" };
}
