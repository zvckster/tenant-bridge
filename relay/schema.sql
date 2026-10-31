-- Production schema for the relay (Postgres). Mirrors the Store interface in src/store.ts.
-- No table holds plaintext ticket data. `mailbox.envelope` is ciphertext, deleted on ack or TTL.

CREATE TABLE IF NOT EXISTS installs (
  id          uuid PRIMARY KEY,
  sign_pub    text NOT NULL,
  dh_pub      text NOT NULL,
  ping_url    text,
  tier        text NOT NULL DEFAULT 'standard',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invites (
  invite_id   uuid PRIMARY KEY,
  install_id  uuid NOT NULL REFERENCES installs(id),
  expires_at  timestamptz NOT NULL,
  failures    int NOT NULL DEFAULT 0,
  locked      boolean NOT NULL DEFAULT false,
  used        boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS connections (
  id          uuid PRIMARY KEY,
  invite_id   uuid NOT NULL REFERENCES invites(invite_id),
  a           uuid NOT NULL REFERENCES installs(id),
  b           uuid NOT NULL REFERENCES installs(id),
  status      text NOT NULL CHECK (status IN ('pending', 'active', 'rejected', 'revoked')),
  bundle_a    jsonb,
  mac_a       text,
  bundle_b    jsonb NOT NULL,
  mac_b       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS connections_a ON connections (a);
CREATE INDEX IF NOT EXISTS connections_b ON connections (b);

CREATE TABLE IF NOT EXISTS mailbox (
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  sender        uuid NOT NULL,
  ch            char(1) NOT NULL CHECK (ch IN ('d', 'c')),
  seq           bigint NOT NULL,
  recipient     uuid NOT NULL,
  envelope      jsonb NOT NULL,
  bytes         int NOT NULL,
  stored_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, sender, ch, seq)
);
CREATE INDEX IF NOT EXISTS mailbox_recipient ON mailbox (recipient, stored_at);
CREATE INDEX IF NOT EXISTS mailbox_ttl ON mailbox (stored_at);

-- Encrypted attachment blobs (unreadable by the relay), deleted on receiver ack or TTL.
CREATE TABLE IF NOT EXISTS blobs (
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  blob_id       uuid NOT NULL,
  sender        uuid NOT NULL,
  recipient     uuid NOT NULL,
  bytes         bigint NOT NULL,
  data          bytea NOT NULL,
  stored_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, blob_id)
);
CREATE INDEX IF NOT EXISTS blobs_ttl ON blobs (stored_at);

-- Metadata only, aggregated per UTC day. Kept 13 months for billing.
CREATE TABLE IF NOT EXISTS usage_daily (
  day           date NOT NULL,
  connection_id uuid NOT NULL,
  sender        uuid NOT NULL,
  messages      bigint NOT NULL DEFAULT 0,
  bytes         bigint NOT NULL DEFAULT 0,
  expired       bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, connection_id, sender)
);

CREATE TABLE IF NOT EXISTS request_nonces (
  install_id  uuid NOT NULL,
  nonce       text NOT NULL,
  expires_at  timestamptz NOT NULL,
  PRIMARY KEY (install_id, nonce)
);
CREATE INDEX IF NOT EXISTS request_nonces_exp ON request_nonces (expires_at);
