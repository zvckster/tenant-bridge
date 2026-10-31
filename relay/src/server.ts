import { buildRelay } from "./app.js";
import { PgStore } from "./pg-store.js";
import { MemoryStore, type Store } from "./store.js";

const port = Number(process.env.PORT ?? 8080);

async function main() {
  let store: Store;
  if (process.env.DATABASE_URL) {
    const pg = await PgStore.connect(process.env.DATABASE_URL);
    await pg.migrate();
    store = pg;
  } else {
    console.warn("DATABASE_URL not set: using the in-memory store (development only, data is lost on restart)");
    store = new MemoryStore();
  }

  const { app, sweep } = buildRelay({
    store,
    pingHostSuffixes: process.env.PING_HOST_SUFFIXES?.split(","),
    notifier: async (url) => {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "mail" }),
        signal: AbortSignal.timeout(5000),
      });
    },
  });

  setInterval(() => void sweep().catch((err) => console.error("sweep failed", err)), 60_000).unref();
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`relay listening on :${port}`);
}

void main();
