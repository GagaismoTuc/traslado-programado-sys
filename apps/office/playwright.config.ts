import { defineConfig, devices } from "@playwright/test";

// C3 harness: real API and PostgreSQL behind the Vite dev server, started by e2e/global-setup.ts.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  globalSetup: "./e2e/global-setup.ts",
  workers: 1,
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  reporter: "list",
  use: { trace: "retain-on-failure" },
  projects: [{
    name: "chromium",
    use: {
      ...devices["Desktop Chrome"],
      // Software WebGL for MapLibre on runners without a GPU.
      launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
    },
  }],
});
