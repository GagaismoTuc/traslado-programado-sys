import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { RoutingHealth } from "../src/app.js";
import { createPool } from "../src/db.js";

// The login limiter keeps its counts in module state: each test loads a fresh app module so its limits start empty.
const appPool = createPool(process.env.TEST_DATABASE_URL!);
const routingUp: RoutingHealth = { osrm: async () => undefined, vroom: async () => undefined };
let app: Awaited<ReturnType<typeof loadApp>>;
let usernames = 0;

async function loadApp(trustedProxyCidrs?: string[]) {
  vi.resetModules();
  const { createApp } = await import("../src/app.js");
  return createApp({ db: appPool, routing: routingUp, config: { serverEpoch: "client-ip-test", trustedProxyCidrs } });
}

// A failed login from a socket peer, as the Node server sees it, with an optional X-Forwarded-For header.
async function failLogin(peer: string, forwardedFor?: string, username = `client-ip-${++usernames}`) {
  return await app.request("/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost",
      ...(forwardedFor === undefined ? {} : { "X-Forwarded-For": forwardedFor }),
    },
    body: JSON.stringify({ username, password: "wrong-password", deviceLabel: "Test browser" }),
  }, { incoming: { socket: { remoteAddress: peer } } });
}

async function failFiveTimes(peer: string, forwardedFor?: string | ((attempt: number) => string)) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const header = typeof forwardedFor === "function" ? forwardedFor(attempt) : forwardedFor;
    expect((await failLogin(peer, header)).status).toBe(401);
  }
}

afterAll(async () => {
  await appPool.end();
});

describe("client address behind trusted proxies", () => {
  it("gives two clients behind the same trusted proxy separate login limits", async () => {
    app = await loadApp(["172.16.0.0/12"]);
    await failFiveTimes("172.18.0.3", "203.0.113.5");
    const sixth = await failLogin("172.18.0.3", "203.0.113.5");
    expect(sixth.status).toBe(429);
    expect(await sixth.json()).toEqual({ error: "Too many login attempts" });
    expect((await failLogin("172.18.0.3", "198.51.100.7")).status).toBe(401);
    // The same proxy seen as an IPv4-mapped IPv6 socket address is still trusted.
    expect((await failLogin("::ffff:172.18.0.3", "203.0.113.5")).status).toBe(429);
  });

  it("limits a peer that is not a trusted proxy by its socket address whatever X-Forwarded-For says", async () => {
    for (const trustedProxyCidrs of [undefined, ["172.16.0.0/12"]]) {
      app = await loadApp(trustedProxyCidrs);
      await failFiveTimes("203.0.113.9", (attempt) => `198.51.100.${attempt + 1}`);
      expect((await failLogin("203.0.113.9", "198.51.100.7")).status).toBe(429);
      expect((await failLogin("203.0.113.9", "198.51.100.200")).status).toBe(429);
      expect((await failLogin("203.0.113.9")).status).toBe(429);
      // Another untrusted peer sending the same header is not limited: the limit was on 203.0.113.9, not on the header.
      expect((await failLogin("203.0.113.10", "198.51.100.7")).status).toBe(401);
    }
  });

  it("takes the rightmost address that is not a trusted proxy so a client cannot prepend one", async () => {
    app = await loadApp(["172.16.0.0/12"]);
    await failFiveTimes("172.18.0.3", "1.2.3.4, 203.0.113.5, 172.18.0.2");
    expect((await failLogin("172.18.0.3", "203.0.113.5")).status).toBe(429);
    expect((await failLogin("172.18.0.3", "1.2.3.4")).status).toBe(401);
  });

  it("falls back to the socket address for a missing, empty, malformed or all-proxy X-Forwarded-For", async () => {
    app = await loadApp(["172.16.0.0/12"]);
    const headers = [undefined, "", "not-an-address", "203.0.113.5:443", "172.18.0.2, 172.20.0.9"];
    for (const [index, header] of headers.entries()) {
      const peer = `172.18.1.${index + 1}`;
      await failFiveTimes(peer, header);
      expect((await failLogin(peer, header)).status).toBe(429);
      // Another proxy peer with the same header is not limited: the key was the socket address, never `unknown`.
      expect((await failLogin(`172.18.2.${index + 1}`, header)).status).toBe(401);
    }
  });

  it("keeps the username limit across clients behind a trusted proxy", async () => {
    app = await loadApp(["172.16.0.0/12"]);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await failLogin("172.18.0.3", `203.0.113.${attempt + 1}`, "client-ip-shared")).status).toBe(401);
    }
    expect((await failLogin("172.18.0.3", "198.51.100.7", "client-ip-shared")).status).toBe(429);
    expect((await failLogin("172.18.0.3", "198.51.100.7")).status).toBe(401);
  });

  it("refuses to start the server with a malformed TRUSTED_PROXY_CIDRS", () => {
    const result = spawnSync(process.execPath, ["./node_modules/tsx/dist/cli.mjs", "src/server.ts"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        SERVER_EPOCH: "client-ip-test",
        DATABASE_URL: "postgres://app:secret@127.0.0.1:1/app",
        OSRM_URL: "http://127.0.0.1:5000",
        VROOM_URL: "http://127.0.0.1:3001",
        TRUSTED_PROXY_CIDRS: "999.1.1.1/40",
      },
      timeout: 8000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("TRUSTED_PROXY_CIDRS must be a comma-separated list of CIDRs");
  });
});
