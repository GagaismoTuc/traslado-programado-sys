import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { randomPort, startApi, startDriver, startOffice, type StartedServer } from "./servers";

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

// Listeners on one port and every address a server could bind it on: on Windows a listener on the wildcard address does
// not stop another bind on 0.0.0.0 or 127.0.0.1, on Linux it does and those extra listens fail, which is fine. By default
// they accept connections and never answer them.
async function holdPort(answer?: (socket: Socket) => void): Promise<number> {
  const sockets = new Set<Socket>();
  const hold = async (port: number, host?: string) => {
    const holder: Server = createServer((socket) => {
      sockets.add(socket);
      answer?.(socket);
    });
    await new Promise<void>((resolve, reject) => {
      holder.once("error", reject);
      holder.listen(port, host, resolve);
    });
    cleanups.push(() => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      holder.close(resolve);
    }));
    return (holder.address() as { port: number }).port;
  };
  const port = await hold(0);
  for (const host of ["0.0.0.0", "127.0.0.1", "::1"]) await hold(port, host).catch(() => undefined);
  return port;
}

function started(server: StartedServer) {
  cleanups.push(server.close);
  return server;
}

describe("e2e setup servers", () => {
  it("starts the API, the Office and the driver app on other ports when another listener holds the first one", async () => {
    const taken = await holdPort();
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
    const taken = await holdPort((socket) => {
      socket.end("HTTP/1.1 401 Unauthorized\r\nX-Server-Epoch: another-run\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });

    const api = started(await startApi(taken, apiEnv));

    expect(new URL(api.url).port).not.toBe(String(taken));
    expect((await fetch(`${api.url}/auth/me`)).headers.get("x-server-epoch")).toBe(apiEnv.SERVER_EPOCH);
  }, 60_000);

  it("fails with the API output when the API exits for a reason other than a taken port", async () => {
    const failure = startApi(randomPort(), { ...apiEnv, SERVER_EPOCH: "" });

    await expect(failure).rejects.toThrow(/^The API exited before answering:\n[\s\S]*SERVER_EPOCH is required/);
  }, 60_000);
});
