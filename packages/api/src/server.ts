import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { readConfig } from "./config.js";
import { createPool } from "./db.js";
import { createApiErrorTracker } from "./error-tracking.js";
import { createNominatimGeocoder } from "./geocoding.js";
import { startPositionPurge } from "./position-purge.js";
import { createOsrmRouter, createRoutingHealth, createTravelTime, createVroomSolver } from "./routing.js";

const config = readConfig();
const errorTracker = createApiErrorTracker({
  dsn: config.glitchtipDsn,
  serverEpoch: config.serverEpoch,
  installProcessHandlers: true,
});
const pool = createPool(config.databaseUrl);
const geocoder = config.geocoder === "nominatim"
  ? createNominatimGeocoder({ url: config.nominatimUrl, userAgent: config.nominatimUserAgent })
  : undefined;
const app = createApp({
  db: pool,
  routing: createRoutingHealth(config),
  router: createOsrmRouter(config.osrmUrl),
  geocoder,
  solver: createVroomSolver(config),
  travelTime: createTravelTime(config),
  errorReporter: errorTracker.captureRequestError,
  config,
});
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host });
// Purges Posiciones older than 90 days now and every 24 h (ADR 0002); failures are logged and retried on the next run.
const positionPurge = startPositionPurge({ pool, now: () => new Date() });

async function shutdown() {
  server.close();
  await positionPurge.stop();
  await Promise.all([pool.end(), errorTracker.close()]);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
