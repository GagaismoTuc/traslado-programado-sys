import { expect, it, vi } from "vitest";
import globalSetup from "./global-setup";
import { holdPort } from "./hold-port";
import { randomPort } from "./servers";

// Only the first port of each server comes from this mock; the retries pick theirs inside servers.ts.
vi.mock("./servers", async (importOriginal) => {
  const servers = await importOriginal<typeof import("./servers")>();
  return { ...servers, randomPort: vi.fn(servers.randomPort) };
});

it("starts every server of the e2e setup when another listener holds the first port it tries", async () => {
  const taken = await holdPort();
  vi.mocked(randomPort).mockReturnValue(taken.port);
  const savedEnv = { ...process.env };
  let teardown: (() => Promise<void>) | undefined;
  try {
    teardown = await globalSetup();

    // The API, the Office and the driver app each tried the taken port first.
    expect(randomPort).toHaveBeenCalledTimes(3);
    const office = process.env.E2E_BASE_URL!;
    const driver = process.env.E2E_DRIVER_URL!;
    for (const url of [office, driver]) expect(new URL(url).port).not.toBe(String(taken.port));
    // Both proxy /api to the API of this run, which names its own epoch.
    for (const url of [office, driver]) {
      const response = await fetch(`${url}/api/auth/me`);
      expect(response.status).toBe(401);
      expect(response.headers.get("x-server-epoch")).toMatch(/^c3-e2e-/);
    }
  } finally {
    await teardown?.();
    await taken.close();
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
}, 300_000);
