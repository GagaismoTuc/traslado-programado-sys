import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { holdPort, type HeldPort } from "./hold-port";
import { onFreePort, PORT_ATTEMPTS, randomPort, startApi, startDriver, startOffice, type StartedServer } from "./servers";

// The API answers /auth/me without a session cookie before touching the database, so a closed port is enough here.
const apiEnv = {
  SERVER_EPOCH: "servers-test",
  DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:9/none",
  OSRM_URL: "http://127.0.0.1:9",
  VROOM_URL: "http://127.0.0.1:9",
  GEOCODER: "off",
};

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function held(port: HeldPort) {
  cleanups.push(port.close);
  return port.port;
}

function started(server: StartedServer) {
  cleanups.push(server.close);
  return server;
}

function portInUse(port: number) {
  return Object.assign(new Error(`listen EADDRINUSE: address already in use 0.0.0.0:${port}`), { code: "EADDRINUSE" });
}

function expectApart(ports: number[]) {
  for (const [index, port] of ports.entries()) {
    for (const other of ports.slice(0, index)) expect(Math.abs(port - other), `${port} next to ${other}`).toBeGreaterThan(1);
  }
}

describe("e2e setup servers", () => {
  it("starts the API, the Office and the driver app on other ports when another listener holds the first one", async () => {
    const taken = held(await holdPort());
    const driverOut = await mkdtemp(join(tmpdir(), "driver-servers-test-"));
    cleanups.push(() => rm(driverOut, { recursive: true, force: true }));
    await writeFile(join(driverOut, "index.html"), "<!doctype html><title>driver</title>");

    const api = started(await startApi(taken, apiEnv));
    const office = started(await startOffice(taken, api.url));
    const driver = started(await startDriver(taken, driverOut, api.url));

    for (const server of [api, office, driver]) expect(new URL(server.url).port).not.toBe(String(taken));
    expect((await fetch(`${api.url}/auth/me`)).status).toBe(401);
    expect((await fetch(`${office.url}/api/auth/me`)).status).toBe(401);
    expect(await (await fetch(`${driver.url}/`)).text()).toContain("<title>driver</title>");
  }, 60_000);

  it("starts the API on another port when another API already answers on the first one", async () => {
    const taken = held(await holdPort({
      answer: (socket) => {
        socket.end("HTTP/1.1 401 Unauthorized\r\nX-Server-Epoch: another-run\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      },
    }));

    const api = started(await startApi(taken, apiEnv));

    expect(new URL(api.url).port).not.toBe(String(taken));
    expect((await fetch(`${api.url}/auth/me`)).headers.get("x-server-epoch")).toBe(apiEnv.SERVER_EPOCH);
  }, 60_000);

  // On Windows the API binds 0.0.0.0 next to these listeners and never sees a request, so its bind does not fail.
  it("starts the API on another port when another server answers on IPv4 loopback only", async () => {
    const taken = held(await holdPort({
      hosts: ["127.0.0.1"],
      answer: (socket) => {
        socket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      },
    }));

    const api = started(await startApi(taken, apiEnv));

    expect(new URL(api.url).port).not.toBe(String(taken));
    expect((await fetch(`${api.url}/auth/me`)).headers.get("x-server-epoch")).toBe(apiEnv.SERVER_EPOCH);
  }, 60_000);

  it("starts the API on another port when another server accepts on IPv4 loopback only and never answers", async () => {
    const taken = held(await holdPort({ hosts: ["127.0.0.1"] }));

    const api = started(await startApi(taken, apiEnv));

    expect(new URL(api.url).port).not.toBe(String(taken));
    expect((await fetch(`${api.url}/auth/me`)).headers.get("x-server-epoch")).toBe(apiEnv.SERVER_EPOCH);
  }, 60_000);

  it("fails with the API output when the API exits for a reason other than a taken port", async () => {
    const failure = startApi(randomPort(), { ...apiEnv, SERVER_EPOCH: "" });

    await expect(failure).rejects.toThrow(/^The API exited before answering:\n[\s\S]*SERVER_EPOCH is required/);
  }, 60_000);
});

describe("retries on a taken port", () => {
  it("retries on random ports apart from every port already tried and keeps the first that starts", async () => {
    const tried: number[] = [];

    const server = await onFreePort(21_000, async (port) => {
      tried.push(port);
      if (tried.length < 5) throw portInUse(port);
      return { url: `http://localhost:${port}`, close: async () => {} };
    });

    expect(tried).toHaveLength(5);
    expect(tried[0]).toBe(21_000);
    expectApart(tried);
    expect(server.url).toBe(`http://localhost:${tried[4]}`);
  });

  it("fails naming every port it tried when every attempt is taken", async () => {
    const tried: number[] = [];

    const failure = await onFreePort(21_000, async (port) => {
      tried.push(port);
      throw portInUse(port);
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(`No free port after ${PORT_ATTEMPTS} attempts; tried ${tried.join(", ")}`);
    expect(PORT_ATTEMPTS).toBe(20);
    expect(tried).toHaveLength(20);
    expect(tried[0]).toBe(21_000);
    expectApart(tried);
  });
});
