import { signRequest } from "./auth.js";
import type { Envelope } from "./envelope.js";
import type { Bundle } from "./pairing.js";

/** HTTP transport, injected so the same client runs in Forge (`@forge/api` fetch), Node and tests. */
export type Transport = (req: {
  method: string;
  path: string;
  body: string | Uint8Array;
  headers: Record<string, string>;
  /** Set for blob downloads: the transport returns the raw bytes in `bytes`. */
  binaryResponse?: boolean;
}) => Promise<{ status: number; json: unknown; bytes?: Uint8Array }>;

export class RelayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`relay ${status}: ${code}`);
  }
}

export interface RelayConnection {
  id: string;
  inviteId: string;
  a: string;
  b: string;
  status: "pending" | "active" | "rejected" | "revoked";
  bundleB: Bundle;
  macB: string;
  bundleA?: Bundle;
  macA?: string;
}

/** Thin signed client for the relay API (SPEC §9). */
export class RelayClient {
  constructor(
    private readonly transport: Transport,
    private readonly installId: string,
    private readonly signPriv: string,
    private readonly now: () => number = Date.now,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown, okStatuses = [200, 201, 202]): Promise<T> {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const headers: Record<string, string> = {
      ...signRequest({ installId: this.installId, signPriv: this.signPriv, method, path, body: raw, now: this.now() }),
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await this.transport({ method, path, body: raw, headers });
    if (!okStatuses.includes(res.status)) {
      throw new RelayError(res.status, (res.json as { error?: string } | null)?.error ?? "unknown");
    }
    return res.json as T;
  }

  /** Uploads an encrypted attachment blob for the partner. Idempotent on blobId. */
  async putBlob(connectionId: string, blobId: string, data: Uint8Array): Promise<void> {
    const path = `/v1/connections/${connectionId}/blobs/${blobId}`;
    const headers = {
      ...signRequest({ installId: this.installId, signPriv: this.signPriv, method: "PUT", path, body: data, now: this.now() }),
      "content-type": "application/octet-stream",
    };
    const res = await this.transport({ method: "PUT", path, body: data, headers });
    if (res.status !== 201 && res.status !== 200) {
      throw new RelayError(res.status, (res.json as { error?: string } | null)?.error ?? "unknown");
    }
  }

  async getBlob(connectionId: string, blobId: string): Promise<Uint8Array> {
    const path = `/v1/connections/${connectionId}/blobs/${blobId}`;
    const headers = signRequest({ installId: this.installId, signPriv: this.signPriv, method: "GET", path, body: "", now: this.now() });
    const res = await this.transport({ method: "GET", path, body: "", headers, binaryResponse: true });
    if (res.status !== 200 || !res.bytes) {
      throw new RelayError(res.status, (res.json as { error?: string } | null)?.error ?? "blob_unavailable");
    }
    return res.bytes;
  }

  /** The receiver confirms it stored the file: the relay deletes the blob. */
  deleteBlob(connectionId: string, blobId: string) {
    return this.call<{ ok: true }>("DELETE", `/v1/connections/${connectionId}/blobs/${blobId}`);
  }

  register(keys: { signPub: string; dhPub: string }, pingUrl?: string) {
    return this.call<{ installId: string }>("POST", "/v1/installs", { installId: this.installId, ...keys, pingUrl });
  }
  setPingUrl(pingUrl: string) {
    return this.call<{ ok: true }>("PUT", "/v1/installs/me", { pingUrl });
  }
  createInvite(inviteId: string, expiresAt: number) {
    return this.call<{ inviteId: string }>("POST", "/v1/invites", { inviteId, expiresAt });
  }
  acceptInvite(inviteId: string, bundle: Bundle, mac: string) {
    return this.call<{ connectionId: string }>("POST", `/v1/invites/${encodeURIComponent(inviteId)}/accept`, { bundle, mac });
  }
  async listConnections() {
    return (await this.call<{ connections: RelayConnection[] }>("GET", "/v1/connections")).connections;
  }
  confirm(connectionId: string, bundle: Bundle, mac: string) {
    return this.call<{ ok: true }>("POST", `/v1/connections/${connectionId}/confirm`, { bundle, mac });
  }
  reject(connectionId: string, reason: "declined" | "bad_mac") {
    return this.call<{ ok: true }>("POST", `/v1/connections/${connectionId}/reject`, { reason });
  }
  revoke(connectionId: string) {
    return this.call<{ ok: true; dropped: number }>("DELETE", `/v1/connections/${connectionId}`);
  }
  send(env: Envelope) {
    return this.call<{ status: "queued" | "duplicate" }>("POST", `/v1/connections/${env.connectionId}/messages`, env);
  }
  async mailbox(limit = 100) {
    return (await this.call<{ envelopes: Envelope[] }>("GET", `/v1/mailbox?limit=${limit}`)).envelopes;
  }
  ack(connectionId: string, seqs: number[], ctrlSeqs: number[] = []) {
    return this.call<{ deleted: number }>("POST", "/v1/mailbox/ack", { connectionId, seqs, ctrlSeqs });
  }
  usage(from: string, to: string) {
    return this.call<unknown>("GET", `/v1/usage?from=${from}&to=${to}`);
  }
}
