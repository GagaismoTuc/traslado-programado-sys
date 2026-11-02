import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/setup.ts"],
    // One worker per vCPU, at most 4: the CI runner has 2, and Postgres and the routing engines share them (#101).
    maxWorkers: Math.min(4, availableParallelism()),
    testTimeout: 10000,
  },
});
