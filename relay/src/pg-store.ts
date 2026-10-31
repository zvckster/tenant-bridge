import { readFile } from "node:fs/promises";
import pg from "pg";
import type { Bundle, Channel, Envelope } from "@tb/protocol";
import type { BlobMeta, Connection, Install, InviteRecord, MailItem, Store, UsageRow } from "./store.js";

const ms = (col: string) => `(extract(epoch from ${col}) * 1000)::bigint AS ${col}`;
const ts = (i: number) => `to_timestamp($${i}::double precision / 1000.0)`;

/** Columns allowed in partial updates, mapped from the Store field names. */
const INSTALL_COLS: Record<string, string> = { pingUrl: "ping_url", tier: "tier" };
const INVITE_COLS: Record<string, string> = { failures: "failures", locked: "locked", used: "used" };
const CONN_COLS: Record<string, string> = { status: "status", bundleA: "bundle_a", macA: "mac_a", updatedAt: "updated_at" };

function setClause(patch: object, cols: Record<string, string>, timeCols: string[] = []) {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = cols[k];
    if (!col || v === undefined) continue;
    values.push(v);
    sets.push(timeCols.includes(k) ? `${col} = ${ts(values.length + 1)}` : `${col} = $${values.length + 1}`);
  }
  return { sets, values };
}

/** Production Store on Postgres. Schema: relay/schema.sql (applied by migrate()). */
export class PgStore implements Store {
  constructor(private readonly pool: pg.Pool) {}

  static async connect(connectionString: string): Promise<PgStore> {
    return new PgStore(new pg.Pool({ connectionString, max: 10 }));
  }

  async migrate(schemaPath = new URL("../schema.sql", import.meta.url)): Promise<void> {
    await this.pool.query(await readFile(schemaPath, "utf8"));
  }

  close() {
    return this.pool.end();
  }

  // ---- installs

  async putInstall(i: Install) {
    await this.pool.query(
      `INSERT INTO installs (id, sign_pub, dh_pub, ping_url, tier, created_at) VALUES ($1, $2, $3, $4, $5, ${ts(6)})`,
      [i.id, i.signPub, i.dhPub, i.pingUrl ?? null, i.tier, i.createdAt],
    );
  }

  async getInstall(id: string): Promise<Install | undefined> {
    const r = await this.pool.query(`SELECT id, sign_pub, dh_pub, ping_url, tier, ${ms("created_at")} FROM installs WHERE id = $1`, [id]);
    const row = r.rows[0];
    return row && { id: row.id, signPub: row.sign_pub, dhPub: row.dh_pub, pingUrl: row.ping_url ?? undefined, tier: row.tier, createdAt: Number(row.created_at) };
  }

  async updateInstall(id: string, patch: Partial<Install>) {
    const { sets, values } = setClause(patch, INSTALL_COLS);
    if (sets.length) await this.pool.query(`UPDATE installs SET ${sets.join(", ")} WHERE id = $1`, [id, ...values]);
  }

  // ---- invites

  async putInvite(i: InviteRecord) {
    await this.pool.query(
      `INSERT INTO invites (invite_id, install_id, expires_at, failures, locked, used) VALUES ($1, $2, ${ts(3)}, $4, $5, $6)`,
      [i.inviteId, i.installId, i.expiresAt, i.failures, i.locked, i.used],
    );
  }

  async getInvite(id: string): Promise<InviteRecord | undefined> {
    const r = await this.pool.query(`SELECT invite_id, install_id, ${ms("expires_at")}, failures, locked, used FROM invites WHERE invite_id = $1`, [id]);
    const row = r.rows[0];
    return row && { inviteId: row.invite_id, installId: row.install_id, expiresAt: Number(row.expires_at), failures: row.failures, locked: row.locked, used: row.used };
  }

  async updateInvite(id: string, patch: Partial<InviteRecord>) {
    const { sets, values } = setClause(patch, INVITE_COLS);
    if (sets.length) await this.pool.query(`UPDATE invites SET ${sets.join(", ")} WHERE invite_id = $1`, [id, ...values]);
  }

  // ---- connections

  private toConnection(row: any): Connection {
    return {
      id: row.id,
      inviteId: row.invite_id,
      a: row.a,
      b: row.b,
      status: row.status,
      bundleB: row.bundle_b as Bundle,
      macB: row.mac_b,
      bundleA: (row.bundle_a as Bundle | null) ?? undefined,
      macA: row.mac_a ?? undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private readonly connCols = `id, invite_id, a, b, status, bundle_a, mac_a, bundle_b, mac_b, ${ms("created_at")}, ${ms("updated_at")}`;

  async putConnection(c: Connection) {
    await this.pool.query(
      `INSERT INTO connections (id, invite_id, a, b, status, bundle_a, mac_a, bundle_b, mac_b, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, ${ts(10)}, ${ts(11)})`,
      [c.id, c.inviteId, c.a, c.b, c.status, c.bundleA ?? null, c.macA ?? null, c.bundleB, c.macB, c.createdAt, c.updatedAt],
    );
  }

  async getConnection(id: string) {
    const r = await this.pool.query(`SELECT ${this.connCols} FROM connections WHERE id = $1`, [id]);
    return r.rows[0] ? this.toConnection(r.rows[0]) : undefined;
  }

  async updateConnection(id: string, patch: Partial<Connection>) {
    const { sets, values } = setClause(patch, CONN_COLS, ["updatedAt"]);
    if (sets.length) await this.pool.query(`UPDATE connections SET ${sets.join(", ")} WHERE id = $1`, [id, ...values]);
  }

  async listConnections(installId: string) {
    const r = await this.pool.query(`SELECT ${this.connCols} FROM connections WHERE a = $1 OR b = $1 ORDER BY created_at`, [installId]);
    return r.rows.map((row) => this.toConnection(row));
  }

  // ---- mailbox (ciphertext only)

  async putMail(item: MailItem) {
    const e = item.env;
    const r = await this.pool.query(
      `INSERT INTO mailbox (connection_id, sender, ch, seq, recipient, envelope, bytes, stored_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, ${ts(8)}) ON CONFLICT DO NOTHING`,
      [e.connectionId, e.sender, e.ch, e.seq, item.recipient, e, item.bytes, item.storedAt],
    );
    return r.rowCount === 1;
  }

  async listMail(recipient: string, limit: number): Promise<MailItem[]> {
    const r = await this.pool.query(
      `SELECT envelope, recipient, bytes, ${ms("stored_at")} FROM mailbox WHERE recipient = $1 ORDER BY stored_at, seq LIMIT $2`,
      [recipient, limit],
    );
    return r.rows.map((row) => ({ env: row.envelope as Envelope, recipient: row.recipient, bytes: row.bytes, storedAt: Number(row.stored_at) }));
  }

  async deleteMail(connectionId: string, sender: string, ch: Channel, seqs: number[], recipient: string) {
    if (seqs.length === 0) return 0;
    const r = await this.pool.query(
      `DELETE FROM mailbox WHERE connection_id = $1 AND sender = $2 AND ch = $3 AND recipient = $4 AND seq = ANY($5::bigint[])`,
      [connectionId, sender, ch, recipient, seqs],
    );
    return r.rowCount ?? 0;
  }

  async deleteMailForConnection(connectionId: string) {
    const r = await this.pool.query(`DELETE FROM mailbox WHERE connection_id = $1`, [connectionId]);
    return r.rowCount ?? 0;
  }

  async expireMail(cutoff: number) {
    const r = await this.pool.query(
      `DELETE FROM mailbox WHERE stored_at < ${ts(1)} RETURNING recipient, bytes, connection_id, sender`,
      [cutoff],
    );
    return r.rows.map((row) => ({ recipient: row.recipient, bytes: row.bytes, connectionId: row.connection_id, sender: row.sender }));
  }

  // ---- blobs (ciphertext only)

  private toBlobMeta(row: any): BlobMeta {
    return {
      connectionId: row.connection_id,
      blobId: row.blob_id,
      sender: row.sender,
      recipient: row.recipient,
      bytes: Number(row.bytes),
      storedAt: Number(row.stored_at),
    };
  }

  async putBlob(m: BlobMeta, data: Uint8Array) {
    const r = await this.pool.query(
      `INSERT INTO blobs (connection_id, blob_id, sender, recipient, bytes, data, stored_at)
       VALUES ($1, $2, $3, $4, $5, $6, ${ts(7)}) ON CONFLICT DO NOTHING`,
      [m.connectionId, m.blobId, m.sender, m.recipient, m.bytes, Buffer.from(data), m.storedAt],
    );
    return r.rowCount === 1;
  }

  async getBlob(connectionId: string, blobId: string) {
    const r = await this.pool.query(
      `SELECT connection_id, blob_id, sender, recipient, bytes, data, ${ms("stored_at")} FROM blobs WHERE connection_id = $1 AND blob_id = $2`,
      [connectionId, blobId],
    );
    const row = r.rows[0];
    return row ? { meta: this.toBlobMeta(row), data: new Uint8Array(row.data as Buffer) } : undefined;
  }

  async deleteBlob(connectionId: string, blobId: string, recipient: string) {
    const r = await this.pool.query(`DELETE FROM blobs WHERE connection_id = $1 AND blob_id = $2 AND recipient = $3`, [connectionId, blobId, recipient]);
    return r.rowCount === 1;
  }

  async deleteBlobsForConnection(connectionId: string) {
    const r = await this.pool.query(`DELETE FROM blobs WHERE connection_id = $1`, [connectionId]);
    return r.rowCount ?? 0;
  }

  async expireBlobs(cutoff: number) {
    const r = await this.pool.query(
      `DELETE FROM blobs WHERE stored_at < ${ts(1)} RETURNING connection_id, blob_id, sender, recipient, bytes, ${ms("stored_at")}`,
      [cutoff],
    );
    return r.rows.map((row) => this.toBlobMeta(row));
  }

  // ---- usage (metadata only)

  async addUsage(day: string, connectionId: string, sender: string, d: Partial<Pick<UsageRow, "messages" | "bytes" | "expired">>) {
    await this.pool.query(
      `INSERT INTO usage_daily (day, connection_id, sender, messages, bytes, expired) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (day, connection_id, sender) DO UPDATE SET
         messages = usage_daily.messages + EXCLUDED.messages,
         bytes = usage_daily.bytes + EXCLUDED.bytes,
         expired = usage_daily.expired + EXCLUDED.expired`,
      [day, connectionId, sender, d.messages ?? 0, d.bytes ?? 0, d.expired ?? 0],
    );
  }

  async listUsage(connectionIds: string[], fromDay: string, toDay: string): Promise<UsageRow[]> {
    if (connectionIds.length === 0) return [];
    const r = await this.pool.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, connection_id, sender, messages, bytes, expired FROM usage_daily
       WHERE connection_id = ANY($1::uuid[]) AND day BETWEEN $2 AND $3 ORDER BY day`,
      [connectionIds, fromDay, toDay],
    );
    return r.rows.map((row) => ({
      day: row.day,
      connectionId: row.connection_id,
      sender: row.sender,
      messages: Number(row.messages),
      bytes: Number(row.bytes),
      expired: Number(row.expired),
    }));
  }

  // ---- replay protection

  async useNonce(installId: string, nonce: string, expiresAt: number, _now: number) {
    const r = await this.pool.query(
      `INSERT INTO request_nonces (install_id, nonce, expires_at) VALUES ($1, $2, ${ts(3)}) ON CONFLICT DO NOTHING`,
      [installId, nonce, expiresAt],
    );
    return r.rowCount === 1;
  }

  async purgeExpired(now: number) {
    await this.pool.query(`DELETE FROM request_nonces WHERE expires_at < ${ts(1)}`, [now]);
  }
}
