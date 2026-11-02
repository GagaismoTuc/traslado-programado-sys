import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/setup.ts"],
    // One worker per vCPU, at most 4: the CI runner had 2 (`nproc` in #101), shared with Postgres and the routing engines.
    maxWorkers: Math.min(4, availableParallelism()),
    testTimeout: 10000,
  },
});
