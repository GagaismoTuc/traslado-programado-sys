import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { readConfig } from "./config.js";
import { createPool } from "./db.js";
import { createRoutingHealth } from "./routing.js";

const config = readConfig();
const pool = createPool(config.databaseUrl);
const app = createApp({ db: pool, routing: createRoutingHealth(config), config });
const server = serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" });

async function shutdown() {
  server.close();
  await pool.end();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
