import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer, preview } from "vite";

const officeRoot = fileURLToPath(new URL("..", import.meta.url));
export const driverRoot = fileURLToPath(new URL("../../driver", import.meta.url));
export const apiRoot = fileURLToPath(new URL("../../../packages/api", import.meta.url));

export type StartedServer = { url: string; close: () => Promise<void> };

export const PORT_ATTEMPTS = 20;

// A first port to try, below the ephemeral ranges of Linux and Windows. It is never probed: a probe closed and bound
// again later leaves a window for another listener, so a taken port is found by the server's own bind instead.
export function randomPort() {
  return 20_000 + Math.floor(Math.random() * 10_000);
}

// A random port that neither is nor sits next to one already tried, so a block of taken ports is not walked port by port.
function retryPort(tried: number[]) {
  for (;;) {
    const port = randomPort();
    if (tried.every((other) => Math.abs(other - port) > 1)) return port;
  }
}

function isPortInUse(error: unknown) {
  if (!(error instanceof Error)) return false;
  // Vite's strictPort turns EADDRINUSE into this message without a code.
  return (error as NodeJS.ErrnoException).code === "EADDRINUSE" || /^Port \d+ is already in use$/.test(error.message);
}

// Starts a server on `port`, or on a random port each time the last one is taken, up to PORT_ATTEMPTS ports. Any
// other error fails at once.
export async function onFreePort(port: number, start: (port: number) => Promise<StartedServer>) {
  const tried: number[] = [];
  for (let next = port; ; next = retryPort(tried)) {
    tried.push(next);
    try {
      return await start(next);
    } catch (error) {
      if (!isPortInUse(error)) throw error;
      if (tried.length === PORT_ATTEMPTS) {
        throw new Error(`No free port after ${PORT_ATTEMPTS} attempts; tried ${tried.join(", ")}`, { cause: error });
      }
    }
  }
}

// `closed` turns true once the API exited and its output was read in full, so a bind error is never cut off.
async function waitForApi(url: string, epoch: string, closed: () => boolean, output: () => string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (closed()) {
      const error: NodeJS.ErrnoException = new Error(`The API exited before answering:\n${output()}`);
      // The API prints the listen error of Node, which names the code.
      if (output().includes("EADDRINUSE")) error.code = "EADDRINUSE";
      throw error;
    }
    // Until the API binds, another server may hold the port and take the request; the API then exits with EADDRINUSE.
    // So no failed, unanswered or foreign answer counts, only one that names this run's epoch, as every answer of
    // the API does. Bounded, because that other server may accept the request and never answer it.
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) }).catch(() => null);
    if (response?.status === 401 && response.headers.get("x-server-epoch") === epoch) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`The API did not answer ${url}:\n${output()}`);
}

export function startApi(port: number, env: Record<string, string>) {
  return onFreePort(port, async (port) => {
    let output = "";
    const api = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: apiRoot,
      // On loopback only: on Windows a bind on 0.0.0.0 succeeds next to a listener on 127.0.0.1, which then takes
      // every request to the URL below. Two binds on 127.0.0.1 fail with EADDRINUSE on every system.
      env: { ...process.env, ...env, HOST: "127.0.0.1", PORT: String(port) },
    });
    let closed = false;
    const exited = new Promise<void>((resolve) => api.on("close", () => { closed = true; resolve(); }));
    api.stdout.on("data", (chunk) => { output += chunk; });
    api.stderr.on("data", (chunk) => { output += chunk; });
    // Waits for the process to be gone, so the next attempt or the test runner never meets it still holding the port.
    const stop = async () => {
      api.kill();
      await exited;
    };
    const url = `http://127.0.0.1:${port}`;
    try {
      await waitForApi(`${url}/auth/me`, env.SERVER_EPOCH, () => closed, () => output);
    } catch (error) {
      await stop();
      throw error;
    }
    return { url, close: stop };
  });
}

export function startOffice(port: number, apiUrl: string) {
  return onFreePort(port, async (port) => {
    const url = `http://localhost:${port}`;
    // vite.config.ts and the Office read these from the environment; destinations.e2e.ts reads VITE_MAP_STYLE_URL too.
    process.env.API_PROXY_TARGET = apiUrl;
    process.env.VITE_API_URL = "/api";
    // Read when the server is created, so it names the port of this attempt.
    process.env.VITE_MAP_STYLE_URL = `${url}/e2e/map-style.json`;
    const server = await createViteServer({ root: officeRoot, server: { host: "localhost", port, strictPort: true } });
    try {
      await server.listen();
    } catch (error) {
      await server.close();
      throw error;
    }
    return { url, close: () => server.close() };
  });
}

export function startDriver(port: number, outDir: string, apiUrl: string) {
  return onFreePort(port, async (port) => {
    // Unlike the Office dev server there is nothing to close on a failure: preview() binds as its last step and, when
    // the bind fails, throws without returning the server, which never listened.
    const server = await preview({
      root: driverRoot,
      logLevel: "warn",
      build: { outDir },
      preview: {
        host: "localhost", port, strictPort: true,
        proxy: { "/api": { target: apiUrl, rewrite: (path) => path.replace(/^\/api/, "") } },
      },
    });
    return { url: `http://localhost:${port}`, close: () => server.close() };
  });
}
