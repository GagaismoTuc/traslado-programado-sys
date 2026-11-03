import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer, preview } from "vite";

const officeRoot = fileURLToPath(new URL("..", import.meta.url));
export const driverRoot = fileURLToPath(new URL("../../driver", import.meta.url));
export const apiRoot = fileURLToPath(new URL("../../../packages/api", import.meta.url));

export type StartedServer = { url: string; close: () => Promise<void> };

const PORT_ATTEMPTS = 20;

// A first port to try, below the ephemeral ranges of Linux and Windows. It is never probed: a probe closed and bound
// again later leaves a window for another listener, so a taken port is found by the server's own bind instead.
export function randomPort() {
  return 20_000 + Math.floor(Math.random() * 10_000);
}

function isPortInUse(error: unknown) {
  if (!(error instanceof Error)) return false;
  // Vite's strictPort turns EADDRINUSE into this message without a code.
  return (error as NodeJS.ErrnoException).code === "EADDRINUSE" || /^Port \d+ is already in use$/.test(error.message);
}

// Starts a server on `port`, or on the next port each time that one is taken. Any other error fails at once.
async function onFirstFreePort(port: number, start: (port: number) => Promise<StartedServer>) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await start(port + attempt);
    } catch (error) {
      if (!isPortInUse(error) || attempt === PORT_ATTEMPTS - 1) throw error;
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
    // Bounded, because the listener that holds a taken port may accept the request and never answer it.
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) }).catch(() => null);
    // Every answer of the API names its epoch, so another API that holds the port is not taken for this one.
    if (response?.status === 401 && response.headers.get("x-server-epoch") === epoch) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`The API did not answer ${url}:\n${output()}`);
}

export function startApi(port: number, env: Record<string, string>) {
  return onFirstFreePort(port, async (port) => {
    let output = "";
    const api = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: apiRoot,
      env: { ...process.env, ...env, PORT: String(port) },
    });
    let closed = false;
    api.stdout.on("data", (chunk) => { output += chunk; });
    api.stderr.on("data", (chunk) => { output += chunk; });
    api.on("close", () => { closed = true; });
    const url = `http://127.0.0.1:${port}`;
    try {
      await waitForApi(`${url}/auth/me`, env.SERVER_EPOCH, () => closed, () => output);
    } catch (error) {
      api.kill();
      throw error;
    }
    return { url, close: async () => { api.kill(); } };
  });
}

export function startOffice(port: number, apiUrl: string) {
  return onFirstFreePort(port, async (port) => {
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
  return onFirstFreePort(port, async (port) => {
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
