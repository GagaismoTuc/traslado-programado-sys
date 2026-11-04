import { afterAll, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { createPool } from "../src/db.js";

const db = createPool(process.env.TEST_DATABASE_URL!);
afterAll(async () => db.end());

it("does not split a global IPv6 client by zone suffix", async () => {
  const config = readConfig({
    SERVER_EPOCH: "review",
    DATABASE_URL: "postgres://x:x@localhost/x",
    OSRM_URL: "http://localhost:5000",
    VROOM_URL: "http://localhost:3001",
    TRUSTED_PROXY_CIDRS: "172.16.0.0/12",
  });
  const app = createApp({
    db,
    routing: { osrm: async () => {}, vroom: async () => {} },
    config,
  });
  for (let i = 0; i < 6; i++) {
    const response = await app.request("/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost",
        "X-Forwarded-For": `2001:db8:55::1%zone${i}`,
      },
      body: JSON.stringify({ username: `audit-zone-${i}`, password: "wrong", deviceLabel: "audit" }),
    }, { incoming: { socket: { remoteAddress: "172.18.10.4" } } });
    expect(response.status).toBe(i === 5 ? 429 : 401);
  }
});
