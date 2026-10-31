# Jira Tenant Bridge

Syncs selected Jira Cloud tickets between two independent companies. The traffic
is end-to-end encrypted, and the vendor relay only ever sees ciphertext.

The full design is in [docs/SPEC.md](docs/SPEC.md).

```
packages/protocol   Shared crypto, pairing, wire formats, permission engine, relay client
relay/              Vendor-hosted relay (Fastify). Pairing broker, encrypted mailbox, metering
forge-app/          The Marketplace app installed on each tenant (Forge, UI Kit admin page)
```

## Develop

```bash
npm install
npm run build        # protocol + relay
npm test             # all suites (relay store tests also run on Postgres if TEST_DATABASE_URL is set)
npm run typecheck    # all three packages
npm run dev -w @tb/relay   # relay on :8080 (in-memory store unless DATABASE_URL is set)
```

Tests:
- `packages/protocol`: crypto, pairing, delivery state machine, permission engine.
- `relay`: the HTTP API, run against both the in-memory and the Postgres store.
- `forge-app`: the **real app code** for two tenants (Acme and Globex) running against
  the real relay in-process. Jira and Forge storage are simulated per tenant
  (`forge-app/test/harness.ts`). Covers pairing, scoped sharing, comments both ways,
  status/field permissions with revert, lost messages, Jira outages,
  reconciliation, attachments and revocation.

## Run the relay

```bash
docker build -f relay/Dockerfile -t tenant-bridge-relay .
docker run -p 8080:8080 -e DATABASE_URL=postgres://user:pass@host/db tenant-bridge-relay
```

The schema (`relay/schema.sql`) is applied on startup. The relay stores ciphertext
only until delivery, plus daily usage metadata.

## Deploy the Forge app (needs an Atlassian developer account)

```bash
npm i -g @forge/cli
cd forge-app
forge register                      # replaces app.id in manifest.yml
# set the relay domain in manifest.yml → permissions.external.fetch.backend
forge variables set RELAY_URL https://relay.your-domain.com
forge deploy && forge install       # repeat the install on a second test site
```

Then on site A, open **Apps → Tenant Bridge** and choose **Create invite**. On site B,
enter the Connection ID and Pairing key and choose **Connect**. Back on site A,
check the fingerprint, choose **Approve**, then save sharing rules on both sides.

## Status

Tested in simulation; **not yet run on real Jira Cloud sites**. The Atlassian
behaviours this depends on that still need confirming are listed in SPEC §13.
What's next is in SPEC §12.
