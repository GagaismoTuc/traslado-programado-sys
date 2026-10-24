import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createServer as createViteServer } from "vite";

const run = promisify(execFile);
const officeRoot = fileURLToPath(new URL("..", import.meta.url));
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

  const [apiPort, webPort] = [await freePort(), await freePort()];
  let apiOutput = "";
  const api = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: apiRoot,
    env: {
      ...process.env,
      SERVER_EPOCH: "c3-e2e",
      DATABASE_URL: withCredentials(rootUrl, "traslado_app", applicationPassword),
      // Only /health uses routing; the C3 tests never call it.
      OSRM_URL: "http://127.0.0.1:9",
      VROOM_URL: "http://127.0.0.1:9",
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

  process.env.E2E_BASE_URL = baseUrl;
  process.env.E2E_DATABASE_URL = migrationUrl;
  return async () => {
    await web.close();
    api.kill();
    await container.stop();
  };
}
