import type { Bundle, Channel, Envelope } from "@tb/protocol";

export type Tier = "free" | "standard" | "premium";

export interface Install {
  id: string;
  signPub: string;
  dhPub: string;
  pingUrl?: string;
  tier: Tier;
  createdAt: number;
}

export interface InviteRecord {
  inviteId: string;
  installId: string;
  expiresAt: number;
  failures: number;
  locked: boolean; // an accept is pending review by the inviter
  used: boolean;
}

export type ConnectionStatus = "pending" | "active" | "rejected" | "revoked";

export interface Connection {
  id: string;
  inviteId: string;
  a: string; // inviter
  b: string; // acceptor
  status: ConnectionStatus;
  bundleB: Bundle;
  macB: string;
  bundleA?: Bundle;
  macA?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MailItem {
  env: Envelope;
  recipient: string;
  bytes: number;
  storedAt: number;
}

/** An encrypted attachment waiting for the receiver. The relay cannot read it. */
export interface BlobMeta {
  connectionId: string;
  blobId: string;
  sender: string;
  recipient: string;
  bytes: number;
  storedAt: number;
}

/** Daily metadata only: never content. */
export interface UsageRow {
  day: string; // YYYY-MM-DD (UTC)
  connectionId: string;
  sender: string;
  messages: number;
  bytes: number;
  expired: number;
}

/**
 * Persistence boundary. MemoryStore is for development and tests; production uses
 * Postgres (see relay/schema.sql). Mailbox rows hold ciphertext only and are deleted
 * on ack or TTL.
 */
export interface Store {
  putInstall(i: Install): Promise<void>;
  getInstall(id: string): Promise<Install | undefined>;
  updateInstall(id: string, patch: Partial<Install>): Promise<void>;

  putInvite(i: InviteRecord): Promise<void>;
  getInvite(id: string): Promise<InviteRecord | undefined>;
  updateInvite(id: string, patch: Partial<InviteRecord>): Promise<void>;

  putConnection(c: Connection): Promise<void>;
  getConnection(id: string): Promise<Connection | undefined>;
  updateConnection(id: string, patch: Partial<Connection>): Promise<void>;
  listConnections(installId: string): Promise<Connection[]>;

  /** Returns false if (connection, sender, channel, seq) already exists. */
  putMail(item: MailItem): Promise<boolean>;
  listMail(recipient: string, limit: number): Promise<MailItem[]>;
  deleteMail(connectionId: string, sender: string, ch: Channel, seqs: number[], recipient: string): Promise<number>;
  deleteMailForConnection(connectionId: string): Promise<number>;
  /** Removes items stored before `cutoff`; returns them (without content) for metering. */
  expireMail(cutoff: number): Promise<Array<Pick<MailItem, "recipient" | "bytes"> & { connectionId: string; sender: string }>>;

  addUsage(day: string, connectionId: string, sender: string, delta: Partial<Pick<UsageRow, "messages" | "bytes" | "expired">>): Promise<void>;
  listUsage(connectionIds: string[], fromDay: string, toDay: string): Promise<UsageRow[]>;

  /** Remembers a request nonce; returns false if it was already seen. `now` is the relay clock. */
  useNonce(installId: string, nonce: string, expiresAt: number, now: number): Promise<boolean>;

  /** Returns false if the blob already exists (uploads are idempotent). */
  putBlob(meta: BlobMeta, data: Uint8Array): Promise<boolean>;
  getBlob(connectionId: string, blobId: string): Promise<{ meta: BlobMeta; data: Uint8Array } | undefined>;
  deleteBlob(connectionId: string, blobId: string, recipient: string): Promise<boolean>;
  deleteBlobsForConnection(connectionId: string): Promise<number>;
  /** Removes blobs stored before `cutoff`; returns their metadata for metering. */
  expireBlobs(cutoff: number): Promise<BlobMeta[]>;

  /** Optional housekeeping (expired nonces), run with the TTL sweep. */
  purgeExpired?(now: number): Promise<void>;
}

const mailKey = (connectionId: string, sender: string, ch: Channel, seq: number) =>
  `${connectionId}:${sender}:${ch}:${seq}`;

export class MemoryStore implements Store {
  private installs = new Map<string, Install>();
  private invites = new Map<string, InviteRecord>();
  private connections = new Map<string, Connection>();
  private mail = new Map<string, MailItem>();
  private usage = new Map<string, UsageRow>();
  private nonces = new Map<string, number>();
  private blobs = new Map<string, { meta: BlobMeta; data: Uint8Array }>();

  async putBlob(meta: BlobMeta, data: Uint8Array) {
    const k = `${meta.connectionId}:${meta.blobId}`;
    if (this.blobs.has(k)) return false;
    this.blobs.set(k, { meta, data });
    return true;
  }
  async getBlob(connectionId: string, blobId: string) {
    return this.blobs.get(`${connectionId}:${blobId}`);
  }
  async deleteBlob(connectionId: string, blobId: string, recipient: string) {
    const k = `${connectionId}:${blobId}`;
    if (this.blobs.get(k)?.meta.recipient !== recipient) return false;
    return this.blobs.delete(k);
  }
  async deleteBlobsForConnection(connectionId: string) {
    let n = 0;
    for (const [k, b] of this.blobs) if (b.meta.connectionId === connectionId && this.blobs.delete(k)) n++;
    return n;
  }
  async expireBlobs(cutoff: number) {
    const out: BlobMeta[] = [];
    for (const [k, b] of this.blobs) {
      if (b.meta.storedAt < cutoff) {
        this.blobs.delete(k);
        out.push(b.meta);
      }
    }
    return out;
  }

  async putInstall(i: Install) {
    this.installs.set(i.id, i);
  }
  async getInstall(id: string) {
    return this.installs.get(id);
  }
  async updateInstall(id: string, patch: Partial<Install>) {
    const cur = this.installs.get(id);
    if (cur) this.installs.set(id, { ...cur, ...patch });
  }

  async putInvite(i: InviteRecord) {
    this.invites.set(i.inviteId, i);
  }
  async getInvite(id: string) {
    return this.invites.get(id);
  }
  async updateInvite(id: string, patch: Partial<InviteRecord>) {
    const cur = this.invites.get(id);
    if (cur) this.invites.set(id, { ...cur, ...patch });
  }

  async putConnection(c: Connection) {
    this.connections.set(c.id, c);
  }
  async getConnection(id: string) {
    return this.connections.get(id);
  }
  async updateConnection(id: string, patch: Partial<Connection>) {
    const cur = this.connections.get(id);
    if (cur) this.connections.set(id, { ...cur, ...patch });
  }
  async listConnections(installId: string) {
    return [...this.connections.values()].filter((c) => c.a === installId || c.b === installId);
  }

  async putMail(item: MailItem) {
    const k = mailKey(item.env.connectionId, item.env.sender, item.env.ch, item.env.seq);
    if (this.mail.has(k)) return false;
    this.mail.set(k, item);
    return true;
  }
  async listMail(recipient: string, limit: number) {
    return [...this.mail.values()]
      .filter((m) => m.recipient === recipient)
      .sort((x, y) => x.storedAt - y.storedAt || x.env.seq - y.env.seq)
      .slice(0, limit);
  }
  async deleteMail(connectionId: string, sender: string, ch: Channel, seqs: number[], recipient: string) {
    let n = 0;
    for (const seq of seqs) {
      const k = mailKey(connectionId, sender, ch, seq);
      if (this.mail.get(k)?.recipient === recipient && this.mail.delete(k)) n++;
    }
    return n;
  }
  async deleteMailForConnection(connectionId: string) {
    let n = 0;
    for (const [k, m] of this.mail) {
      if (m.env.connectionId === connectionId) {
        this.mail.delete(k);
        n++;
      }
    }
    return n;
  }
  async expireMail(cutoff: number) {
    const out: Array<{ recipient: string; bytes: number; connectionId: string; sender: string }> = [];
    for (const [k, m] of this.mail) {
      if (m.storedAt < cutoff) {
        this.mail.delete(k);
        out.push({ recipient: m.recipient, bytes: m.bytes, connectionId: m.env.connectionId, sender: m.env.sender });
      }
    }
    return out;
  }

  async addUsage(day: string, connectionId: string, sender: string, delta: Partial<Pick<UsageRow, "messages" | "bytes" | "expired">>) {
    const k = `${day}:${connectionId}:${sender}`;
    const row = this.usage.get(k) ?? { day, connectionId, sender, messages: 0, bytes: 0, expired: 0 };
    row.messages += delta.messages ?? 0;
    row.bytes += delta.bytes ?? 0;
    row.expired += delta.expired ?? 0;
    this.usage.set(k, row);
  }
  async listUsage(connectionIds: string[], fromDay: string, toDay: string) {
    const ids = new Set(connectionIds);
    return [...this.usage.values()].filter((u) => ids.has(u.connectionId) && u.day >= fromDay && u.day <= toDay);
  }

  async useNonce(installId: string, nonce: string, expiresAt: number, now: number) {
    const k = `${installId}:${nonce}`;
    for (const [key, exp] of this.nonces) if (exp < now) this.nonces.delete(key);
    if (this.nonces.has(k)) return false;
    this.nonces.set(k, expiresAt);
    return true;
  }
}
