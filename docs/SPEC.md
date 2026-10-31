# Jira Tenant Bridge — Specification v0.1

Status: draft. Working name; rename before Marketplace listing.

## 1. Goal

A paid Atlassian Marketplace app (Forge) that lets two independent Jira Cloud
tenants, usually two different companies, keep selected tickets in sync, with
text, comments, images and documents, in both directions.

Hard requirements:

- **Each tenant controls what it shares and what the partner may do.** Rules are
  enforced on the tenant's own side, never trusted from the partner.
- **End-to-end encryption.** The vendor's relay carries only ciphertext and
  cannot read, forge or silently alter ticket data.
- **No data retention on the relay.** Ciphertext is held only until delivery is
  acknowledged (or a TTL expires), then deleted. Only metadata (sizes, counts,
  timestamps, connection IDs) is kept, for metering, rate limits and billing.
- **Self-healing.** Lost, duplicated, reordered or corrupted messages are detected
  and corrected automatically.

## 2. Components

```
Tenant A (Jira Cloud)                 Vendor                    Tenant B (Jira Cloud)
┌────────────────────┐        ┌──────────────────────┐        ┌────────────────────┐
│ Forge app A        │        │ Relay API            │        │ Forge app B        │
│ - admin UI         │ HTTPS  │ - install registry   │ HTTPS  │ - admin UI         │
│ - policy engine    │◄──────►│ - pairing broker     │◄──────►│ - policy engine    │
│ - crypto (keys)    │ cipher │ - mailbox (TTL)      │ cipher │ - crypto (keys)    │
│ - sync engine      │  text  │ - metering / quotas  │  text  │ - sync engine      │
└────────────────────┘        └──────────────────────┘        └────────────────────┘
```

| Package | Role |
|---|---|
| `packages/protocol` | Shared wire formats, crypto, pairing, policy evaluation. Pure TS, no I/O. Used by both the app and the relay. |
| `relay` | Vendor-hosted HTTP service. Never holds decryption keys. |
| `forge-app` | The Marketplace app installed on each tenant. |

## 3. Identities and keys

On first run, each installation generates:

| Key | Algorithm | Purpose |
|---|---|---|
| Identity key | Ed25519 | Signs every request to the relay. |
| Agreement key | X25519 | Derives per-connection encryption keys with a partner. |

Private keys are stored only in Forge secret storage (`kvs.setSecret`) on that
tenant. The app also generates its **Install ID** (UUID) and registers it with the
relay together with the public keys. The registration request is signed with the new
identity key, which proves the app holds the private half.

**Key fingerprint:** the first 20 bytes of `SHA-256("tb/v1/fp" ‖ signPub ‖ dhPub)`,
shown to admins as 8 groups of 5 digits for optional out-of-band comparison.

## 4. Pairing (connecting two tenants)

The user-facing flow is "share a Connection ID and a Pairing key."

1. **Admin A creates an invite.** App A generates locally:
   - `inviteId`: a UUID, sent to the relay.
   - `pairingSecret`: 16 random bytes, **never sent to the relay**.

   The admin sees:

   ```
   Connection ID:  7f3c2b1e-....-....
   Pairing key:    K7QD-M2XA-9PLE-...   (base32 of pairingSecret)
   ```

   Invites are single-use and expire after 24 h.
2. **Admin A sends both values to admin B** out of band (email, call, chat).
3. **Admin B enters them.** App B derives `kPair` and sends an *accept* to the relay:
   `bundleB` (installId, public keys, site display name, app version) plus
   `macB = HMAC-SHA256(kPair, "tb/v1/accept" ‖ canon(inviteId) ‖ canon(bundleB))`.
4. **The relay creates a pending connection** (a `connectionId` UUID) and notifies A.
5. **App A verifies `macB`.** On failure the request is rejected, and the invite is
   burned after 5 failures. On success, admin A sees B's site name and fingerprint
   and approves. App A then sends
   `macA = HMAC(kPair, "tb/v1/confirm" ‖ canon(connectionId) ‖ canon(bundleA) ‖ canon(bundleB))`.
6. **App B verifies `macA`.** The connection becomes active on both sides.

`kPair = HKDF-SHA256(ikm = pairingSecret, salt = inviteId, info = "tb/v1/pair")`.

**Why the relay cannot man-in-the-middle:** both bundles are authenticated with a
key derived from a secret the relay never sees. To substitute its own keys, the
relay would also need the pairing key from the out-of-band channel.

## 5. Connection keys and message encryption

```
shared = X25519(myDhPriv, peerDhPub)
root   = HKDF-SHA256(ikm = shared ‖ pairingSecret, salt = connectionId,
                     info = "tb/v1/root")
kSend(epoch, sender) = HKDF-SHA256(ikm = root, salt = connectionId,
                     info = "tb/v1/msg|" + epoch + "|" + senderInstallId)
```

- Each direction has its own key. A key never encrypts in both directions.
- **AEAD:** XChaCha20-Poly1305 with a random 24-byte nonce.
- **Associated data:** the canonical envelope header. Any change to the routing
  metadata breaks decryption.
- **Channel** (`ch`): `d` = data, ordered and retransmitted until acknowledged.
  `c` = control (`ack`/`nack` only), unordered, best effort, never acknowledged
  itself. Keeping acks out of the acknowledged stream prevents ack-of-ack loops.
  Control payloads are cumulative, so a lost one is harmless. The receiver drops a
  payload that arrives on the wrong channel.
- **Epoch:** incremented on key rotation (every 30 days or 1M messages). The
  receiver accepts the current epoch and the one before it.
- **v1 limitation:** `root` is derived from static keys. A later private-key
  compromise exposes past traffic. v2 adds ephemeral DH ratcheting for forward
  secrecy.

### Envelope

```jsonc
{
  "v": 1,
  "connectionId": "uuid",
  "sender": "installId",
  "ch": "d",            // "d" data | "c" control
  "seq": 42,            // per (connection, sender, ch), starts at 1
  "epoch": 0,
  "nonce": "base64url",
  "ct": "base64url"     // ciphertext + Poly1305 tag
}
```

The relay sees only the header fields plus the ciphertext length.

## 6. Delivery, integrity and self-correction

| Problem | Detection | Correction |
|---|---|---|
| Tampered message | AEAD tag fails | Receiver discards it; sender retransmits after the ack timeout. |
| Duplicate | `seq` ≤ applied high-water mark | Ignored. The receiver re-sends its `ack`, because a duplicate means the sender missed it. |
| Lost or expired message | Gap in `seq` | Receiver sends `nack{missing}`; sender retransmits the same envelope from its outbox. |
| Reordered messages | `seq` out of order | Receiver buffers and applies in `seq` order. |
| Missed Jira event | Reconciliation (below) | Resync of the affected tickets. |
| Partner and local state diverged | Manifest hash mismatch | `resync.request` → fresh snapshot. |

Flow for every message:

1. The sender writes the envelope to its **outbox** (Forge storage), then posts it to the relay.
2. The relay stores it in the receiver's **mailbox** and notifies the receiver
   (a ping to its Forge web trigger, carrying no content).
3. The receiver pulls and decrypts the message, stores it in its own inbox and applies
   it in `seq` order. It then sends a **relay ack** and the relay deletes the
   ciphertext immediately. Anything that fails to decrypt is acked and dropped; the
   sender retransmits the original. If the receiver's buffer is full, it does not
   relay-ack, so the message waits on the relay.
4. The receiver sends an encrypted **e2e ack** `{appliedUpTo, rejected[]}`. The sender
   deletes the acknowledged outbox entries.

Retransmits reuse the identical envelope, which makes them idempotent at every hop.
Mailbox TTL is 7 days. Anything expired is recovered through `nack` or reconciliation.

**Reconciliation** (scheduled, every 6 h per connection, both roles):

- **As owner:** search the shared scope for issues updated since the last run
  (with a 10-minute overlap) and push their snapshots and any missing attachments.
  The first run has no time filter, so it doubles as the **initial sync** of tickets
  that already existed when the connection was set up.
- **As mirror holder:** send `manifest{items:[{ref, hash}]}` for the mirrors I hold,
  where `hash` = SHA-256 of the last snapshot applied, in chunks of 500.
- **The owner answers a manifest** by rebuilding each snapshot and re-sending the
  ones whose hash differs.
- Not covered yet: comments missed by events, and tickets that left the shared scope
  (the mirror should be told to archive).

**Concurrency inside the app.** Forge can run several invocations at once (event,
relay ping, scheduled tick). Outbox and inbox updates for a connection are serialized
with a short lock: a KVS write with `FAIL_IF_EXISTS` and a 60 s TTL. A busy inbox lock
skips that connection; the mail stays on the relay for the holder.

**Storage layout.** KVS values are limited to about 240 KiB, so the app stores each
queued outbound envelope and each buffered inbound envelope under its own key. It
refuses to queue data envelopes above 200 KiB.

## 7. Payload types (inside the ciphertext)

| Type | Direction | Notes |
|---|---|---|
| `ticket.snapshot` | owner → partner | Full shared view: allowed fields only. |
| `comment.upsert` / `comment.delete` | either | Carries `origin` (tenant + id) and the author's display label. |
| `reaction.set` | either | Emoji on a comment. *Jira's public REST API has no comment reactions; until it does, this is rejected with `not_supported_yet`.* |
| `status.request` | partner → owner | Owner checks it against allowed transitions. |
| `field.request` | partner → owner | Owner checks it against editable fields. |
| `ticket.create.request` | partner → owner | Owner checks the target space and issue type. |
| `attachment.offer` / `attachment.chunk` | either | 96 KiB chunks (so a sealed chunk fits in one KVS value), per-chunk SHA-256 and a whole-file SHA-256. See §7.1. |
| `ack` / `nack` | either | Delivery control. |
| `manifest` / `resync.request` | either | Reconciliation. |
| `policy.summary` | either | Tells the partner UI what it may do. Informational only; never trusted for enforcement. |
| `rejected` | either | `{seq, reason}`, e.g. `capability_denied`. The partner UI shows it, and its mirror is reverted on the next snapshot. |

Every operation carries an `opId` (UUID) so applying it is idempotent.

### 7.1 Attachments and inline images

- **Sender:** for each attachment on a shared ticket (or on my mirror of a partner
  ticket) that my outbound rules allow, it sends one `attachment.offer` followed by
  its chunks, in order on the data channel. Files that came from the partner are
  never sent back, and sent files are remembered per connection.
- **Triggers:** the `created:attachment` event, `Attachment` entries in an issue's
  changelog, every snapshot push, and reconciliation. So files blocked by a policy
  are picked up once the policy allows them.
- **Receiver:** checks the offer against its rules: `partner.attachmentAdd` on my
  tickets, `inbound.attachments` on mirrors, plus a 100 MB hard limit. It stores
  chunks in KVS, verifies the whole-file SHA-256 and size, uploads with a multipart
  POST, records the file's origin, then deletes the chunks.
- **Refusals:** one refused offer produces one `rejected` message; its chunks are
  ignored silently.
- **Inline images:** the description format embeds images by an internal media id,
  and Jira's REST API offers no way to embed a freshly uploaded attachment by id. So
  images become a readable `[name.png — see attachments]` reference, and the file
  itself arrives as an attachment.
- **Deletes:** comment deletion is synced through the `deleted:comment` event.
  Attachment deletion is not synced yet.

## 8. Permission model

Each tenant configures, per connection:

### 8.1 Outbound scope: what I share

- Spaces (project keys), issue types, and an optional JQL filter
  (e.g. `labels = share-acme`).
- Field allow-list. Always included: summary, status, issue type. Optional:
  description, priority, labels, due date, and named custom fields.
- Comments: off, or public only. **Restricted comments (role or group visibility)
  are never shared.**
- Attachments: off, or on with a max size (default 25 MB) and a MIME allow-list.
- **Always excluded:** issues with a security level set.
- People: shown as display name + partner org (default) or anonymized
  ("Acme agent"). Email and accountId are never sent.

### 8.2 Partner capabilities on my tickets

| Capability | Default |
|---|---|
| `comment.create` | on |
| `comment.editOwn` / `comment.deleteOwn` | on |
| `reaction.set` | on |
| `status.transition` with an allowed transition list | off |
| `field.edit` with an allowed field list | off |
| `attachment.add` | off |
| `ticket.create` with a target space and issue type | off |

"Own" means the content's `origin.tenant` is the partner. Origin is recorded by the
tenant that owns the ticket, never taken from the partner's word alone.

### 8.3 Inbound mapping: partner tickets in my Jira

- Target space and issue type for mirrors.
- Status mapping: partner status → my status.
- Mirrors are labelled `tb-mirror` and linked to the partner key in a field or property.

### 8.4 Enforcement

`evaluate(policy, operation) → allow | deny(reason)` lives in `packages/protocol`. It
runs **in the receiving app before every Jira write** and **in the sending app
before every send** (to avoid wasted traffic). Local edits to a mirror that the
partner refuses are reverted when the next snapshot arrives.

Defence in depth: the app's Forge scopes are the minimum needed
(`read:jira-work`, `write:jira-work`, `storage:app`, `read:jira-user`).

## 9. Relay API (v1)

Every request is authenticated with:

- **A Forge Invocation Token (FIT)** via Forge Remote. This proves the call comes
  from this app on a real installation, and carries license state.
  *To verify against current Forge docs.*
- **An Ed25519 request signature:** headers `x-tb-install`, `x-tb-ts`, `x-tb-nonce`
  and `x-tb-sig` over `method ‖ path ‖ ts ‖ nonce ‖ sha256(body)`. There is a ±5 min
  window, and nonces are cached to block replays.

| Method & path | Purpose |
|---|---|
| `POST /v1/installs` | Register the app-generated `installId`, public keys and the web-trigger URL. Self-signed. |
| `PUT  /v1/installs/me` | Update the web-trigger URL. |
| `POST /v1/invites` | Register an `inviteId` with an expiry. |
| `POST /v1/invites/:inviteId/accept` | B submits `bundleB` + `macB` → pending `connectionId`. |
| `GET  /v1/connections` | List connections and pending requests. |
| `POST /v1/connections/:id/confirm` | A submits `bundleA` + `macA`. |
| `POST /v1/connections/:id/reject` | A rejects or reports a bad MAC. |
| `DELETE /v1/connections/:id` | Either side revokes; queued ciphertext is dropped. |
| `POST /v1/connections/:id/messages` | Send an envelope; idempotent on (connection, sender, seq). |
| `GET  /v1/mailbox?limit=` | Pull pending envelopes for this install. |
| `POST /v1/mailbox/ack` | `{connectionId, seqs[], ctrlSeqs[]}` → delete those envelopes. |
| `GET  /v1/usage?from=&to=` | Daily usage for this install. |

Ping URLs must be HTTPS on an allow-listed Atlassian domain, so the relay can't be
used to make requests to arbitrary hosts (SSRF).

The relay validates that `sender` is the authenticated install, that it belongs
to the connection, that the connection is active, the size limit (1 MiB per
envelope), and quotas.

## 10. Metering, quotas and billing

Kept per connection, per direction, per UTC day: message count, ciphertext bytes,
expired-undelivered count. No content and no per-message logs after delivery.

| Tier (example) | Connections | Transfer / month | Max attachment |
|---|---|---|---|
| Free (only with a paying partner) | 1 | 200 MB | 5 MB |
| Standard | 3 | 10 GB | 25 MB |
| Premium | 20 | 100 GB | 100 MB |

- Request rate: a token bucket per install, 600 req/min. Overflow → `429` + `Retry-After`.
- Over quota → `429 quota_exceeded`. The app shows usage and limits in its admin page.
- Pricing on the Marketplace follows the host's user tiers. Transfer quotas are
  mapped to user tiers, with fair-use terms. Whether separate usage-based charges are
  allowed is *to be confirmed with Atlassian Marketplace policy*.

Metadata retention: daily aggregates for 13 months (billing disputes, capacity
planning). Revoked connections are anonymized after 30 days.

## 11. Threat model (summary)

| Threat | Outcome |
|---|---|
| Relay operator or attacker | Sees metadata only. Cannot read or forge. Can drop or delay, which is detected via seq gaps and reconciliation. |
| Malicious or compromised partner | Limited to the capabilities I granted. Everything inbound is validated locally. |
| Pairing key intercepted during the invite window | The attacker could pair first. Mitigations: single use, 24 h expiry, admin approval showing site name and fingerprint. |
| Replay | Prevented by `seq` + AEAD-bound header; relay request nonces. |
| Leaked tenant private keys | Revoke and re-pair. v2 forward secrecy limits past exposure. |
| Atlassian platform | Trusted. The plaintext lives there anyway as the tenant's own data. |

## 12. Roadmap

1. **Done:** keys, pairing, relay, encrypted ticket/comment/status/field sync,
   policy engine.
2. **Done:** Postgres store, app-side locking, reconciliation and initial sync,
   comment deletion, chunked attachments, inline image references.
3. **Next:** Forge Remote/FIT auth on the relay; a form-based admin UI and usage view;
   long transfers via an async event queue; attachment deletion; scope-exit
   handling; reactions (once Jira exposes them).
4. **Later:** forward secrecy (v2 ratchet), Marketplace licensing checks, security
   review and Cloud Fortified.

## 13. Open items to verify against current Atlassian docs

- Forge Remote / `invokeRemote` manifest shape and FIT claims (license, installation id).
- Payload shape of `avi:jira:created:attachment` (the handler accepts `issue.id` or
  `attachment.issueId`). There is no comment-updated event in the Forge event list;
  confirm whether `commented:issue` also fires on edits.
- `requestJira` with a `FormData` body for attachment upload, and binary download
  from `/rest/api/3/attachment/content/{id}`.
- The KVS value size limit assumed above (~240 KiB).
- Forge function memory and timeout limits for attachment chunking.
- Marketplace rules on usage-based add-on charges.
