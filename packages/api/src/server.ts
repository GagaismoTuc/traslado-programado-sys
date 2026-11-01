import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { readConfig } from "./config.js";
import { createPool } from "./db.js";
import { createNominatimGeocoder } from "./geocoding.js";
import { createOsrmRouter, createRoutingHealth } from "./routing.js";

const config = readConfig();
const pool = createPool(config.databaseUrl);
const geocoder = config.geocoder === "nominatim"
  ? createNominatimGeocoder({ url: config.nominatimUrl, userAgent: config.nominatimUserAgent })
  : undefined;
const app = createApp({ db: pool, routing: createRoutingHealth(config), router: createOsrmRouter(config.osrmUrl), geocoder, config });
const server = serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" });

async function shutdown() {
  server.close();
  await pool.end();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
