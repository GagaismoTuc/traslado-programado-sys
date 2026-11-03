import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { startFakeVroom } from "./fake-vroom";
import { apiRoot, randomPort, startApi, startDriver, startOffice } from "./servers";

const run = promisify(execFile);
const driverRoot = fileURLToPath(new URL("../../driver", import.meta.url));

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

  const vroom = await startFakeVroom();
  const api = await startApi(randomPort(), {
    SERVER_EPOCH: "c3-e2e",
    DATABASE_URL: withCredentials(rootUrl, "traslado_app", applicationPassword),
    // OSRM is only probed by /health, which the C3 tests never call; "Order" goes to the fake VROOM.
    OSRM_URL: "http://127.0.0.1:9",
    VROOM_URL: vroom.url,
    GEOCODER: "off",
  });

  const web = await startOffice(randomPort(), api.url);

  // The driver app as a phone runs it: the production build with its service worker, so a tab reloads without signal.
  const driverOut = await mkdtemp(join(tmpdir(), "driver-e2e-"));
  // A child process builds it: NODE_ENV=production in this process would switch the Office dev server to the
  // production JSX runtime, and the dev server above set NODE_ENV to development, which builds without the service worker.
  await run(process.execPath, [join(driverRoot, "node_modules/vite/bin/vite.js"), "build", "--logLevel", "warn", "--outDir", driverOut, "--emptyOutDir"], {
    cwd: driverRoot,
    env: { ...process.env, NODE_ENV: "production" },
  });
  const driver = await startDriver(randomPort(), driverOut, api.url);

  process.env.E2E_BASE_URL = web.url;
  process.env.E2E_DRIVER_URL = driver.url;
  process.env.E2E_DATABASE_URL = migrationUrl;
  return async () => {
    await web.close();
    await driver.close();
    await rm(driverOut, { recursive: true, force: true });
    await api.close();
    await vroom.close();
    await container.stop();
  };
}
