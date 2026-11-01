import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createServer as createViteServer, preview } from "vite";
import { startFakeVroom } from "./fake-vroom";

const run = promisify(execFile);
const officeRoot = fileURLToPath(new URL("..", import.meta.url));
const driverRoot = fileURLToPath(new URL("../../driver", import.meta.url));
const apiRoot = fileURLToPath(new URL("../../../packages/api", import.meta.url));

async function freePort() {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function withCredentials(uri: string, username: string, password: string) {
  const url = new URL(uri);
  url.username = username;
  url.password = password;
  return url.toString();
}

// Runs an API script the same way its package script does, with tsx as the loader.
function apiScript(script: string, env: Record<string, string>) {
  return run(process.execPath, ["--import", "tsx", script], { cwd: apiRoot, env: { ...process.env, ...env } });
}

async function waitForApi(url: string, api: ReturnType<typeof spawn>, output: () => string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (api.exitCode !== null) throw new Error(`The API exited before answering:\n${output()}`);
    const response = await fetch(url).catch(() => null);
    if (response?.status === 401) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`The API did not answer ${url}:\n${output()}`);
}

export default async function globalSetup() {
  const container = await new PostgreSqlContainer("postgres:16.15-alpine")
    .withDatabase("traslado")
    .withUsername("postgres")
    .withPassword(randomBytes(24).toString("hex"))
    .start();
  const migrationPassword = randomBytes(24).toString("hex");
  const applicationPassword = randomBytes(24).toString("hex");
  const rootUrl = container.getConnectionUri();
  const migrationUrl = withCredentials(rootUrl, "traslado_migrator", migrationPassword);
  await apiScript("src/bootstrap.ts", { BOOTSTRAP_DATABASE_URL: rootUrl, MIGRATION_PASSWORD: migrationPassword, APPLICATION_PASSWORD: applicationPassword });
  await apiScript("src/migrate.ts", { MIGRATION_DATABASE_URL: migrationUrl });

  const [apiPort, webPort, driverPort] = [await freePort(), await freePort(), await freePort()];
  const vroom = await startFakeVroom();
  let apiOutput = "";
  const api = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: apiRoot,
    env: {
      ...process.env,
      SERVER_EPOCH: "c3-e2e",
      DATABASE_URL: withCredentials(rootUrl, "traslado_app", applicationPassword),
      // OSRM is only probed by /health, which the C3 tests never call; "Order" goes to the fake VROOM.
      OSRM_URL: "http://127.0.0.1:9",
      VROOM_URL: vroom.url,
      PORT: String(apiPort),
      GEOCODER: "off",
    },
  });
  api.stdout.on("data", (chunk) => { apiOutput += chunk; });
  api.stderr.on("data", (chunk) => { apiOutput += chunk; });
  await waitForApi(`http://127.0.0.1:${apiPort}/auth/me`, api, () => apiOutput);

  const baseUrl = `http://localhost:${webPort}`;
  process.env.API_PROXY_TARGET = `http://127.0.0.1:${apiPort}`;
  process.env.VITE_API_URL = "/api";
  process.env.VITE_MAP_STYLE_URL = `${baseUrl}/e2e/map-style.json`;
  const web = await createViteServer({ root: officeRoot, server: { host: "localhost", port: webPort, strictPort: true } });
  await web.listen();

  // The driver app as a phone runs it: the production build with its service worker, so a tab reloads without signal.
  const driverOut = await mkdtemp(join(tmpdir(), "driver-e2e-"));
  // A child process builds it: NODE_ENV=production in this process would switch the Office dev server to the
  // production JSX runtime, and the dev server above set NODE_ENV to development, which builds without the service worker.
  await run(process.execPath, [join(driverRoot, "node_modules/vite/bin/vite.js"), "build", "--logLevel", "warn", "--outDir", driverOut, "--emptyOutDir"], {
    cwd: driverRoot,
    env: { ...process.env, NODE_ENV: "production" },
  });
  const driver = await preview({
    root: driverRoot,
    logLevel: "warn",
    build: { outDir: driverOut },
    preview: {
      host: "localhost", port: driverPort, strictPort: true,
      proxy: { "/api": { target: process.env.API_PROXY_TARGET, rewrite: (path) => path.replace(/^\/api/, "") } },
    },
  });

  process.env.E2E_BASE_URL = baseUrl;
  process.env.E2E_DRIVER_URL = `http://localhost:${driverPort}`;
  process.env.E2E_DATABASE_URL = migrationUrl;
  return async () => {
    await web.close();
    await driver.close();
    await rm(driverOut, { recursive: true, force: true });
    api.kill();
    await vroom.close();
    await container.stop();
  };
}
