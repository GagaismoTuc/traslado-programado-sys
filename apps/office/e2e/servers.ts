import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer, preview } from "vite";

const officeRoot = fileURLToPath(new URL("..", import.meta.url));
const driverRoot = fileURLToPath(new URL("../../driver", import.meta.url));
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

async function waitForApi(url: string, api: ReturnType<typeof spawn>, output: () => string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (api.exitCode !== null) {
      const error: NodeJS.ErrnoException = new Error(`The API exited before answering:\n${output()}`);
      if (output().includes("EADDRINUSE")) error.code = "EADDRINUSE";
      throw error;
    }
    // Bounded, because the listener that holds a taken port may accept the request and never answer it.
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) }).catch(() => null);
    if (response?.status === 401) return;
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
    api.stdout.on("data", (chunk) => { output += chunk; });
    api.stderr.on("data", (chunk) => { output += chunk; });
    const url = `http://127.0.0.1:${port}`;
    try {
      await waitForApi(`${url}/auth/me`, api, () => output);
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
