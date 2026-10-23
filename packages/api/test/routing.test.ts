import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPool } from "../src/db.js";
import { createRoutingHealth } from "../src/routing.js";
import { composeConfig, osrmRecipe, readRecipe, startRoutingStack, type RoutingStack } from "./routing-harness.js";

const appPool = createPool(process.env.TEST_DATABASE_URL!);
const preprocessing = /osrm-(extract|partition|customize|contract)/;
// A port nothing listens on, standing in for a stopped routing service.
const deadUrl = "http://127.0.0.1:9";

type Step = { type: string; arrival: number; setup: number };
type Solution = { unassigned: { id: number }[]; routes: { steps: Step[] }[] };

let stack: RoutingStack;

beforeAll(async () => {
  stack = await startRoutingStack();
}, 300_000);
afterAll(async () => {
  await Promise.all([stack?.stop(), appPool.end()]);
}, 120_000);

async function solve(problem: unknown): Promise<Solution> {
  const response = await fetch(stack.vroomUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(problem),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Solution;
}

// One vehicle at a corner of the synthetic grid and one job at another corner.
function tinyInstance(timeWindows?: number[][]) {
  return {
    vehicles: [{ id: 1, profile: "car", start: [-65.22, -26.84] }],
    jobs: [{ id: 1, location: [-65.2, -26.82], setup: 60, service: 120, ...(timeWindows ? { time_windows: timeWindows } : {}) }],
  };
}

function jobStep(solution: Solution) {
  const step = solution.routes[0]?.steps.find((candidate) => candidate.type === "job");
  if (!step) throw new Error("job was not routed");
  return step;
}

describe("routing infrastructure", () => {
  it("never runs OSRM preprocessing in the Compose services or the artifact entrypoint", async () => {
    const { ARTIFACT_REPOSITORY, ARTIFACT_VERSION } = await readRecipe();
    const { services } = await composeConfig();
    for (const service of Object.values(services)) {
      expect([...(service.command ?? []), ...(service.entrypoint ?? [])].join(" ")).not.toMatch(preprocessing);
    }
    expect(services.osrm!.image).toBe(`${ARTIFACT_REPOSITORY}:${ARTIFACT_VERSION}`);
    const { stdout } = await promisify(execFile)("docker", ["image", "inspect", "--format", "{{json .Config.Entrypoint}}", stack.osrmImage]);
    expect(JSON.parse(stdout)).toEqual(["/usr/local/bin/serve-osrm"]);
    expect(await readFile(join(osrmRecipe, "serve.sh"), "utf8")).not.toMatch(preprocessing);
  });

  it("logs the OSRM artifact version in use when the server starts", async () => {
    expect(await stack.logs("osrm")).toContain(`OSRM artifact version: ${stack.artifactVersion}`);
  });

  it("solves a tiny instance against the real OSRM and VROOM containers", async () => {
    const solution = await solve(tinyInstance());
    expect(solution.unassigned).toEqual([]);
    expect(jobStep(solution).arrival).toBeGreaterThan(0);
  });

  it("applies VROOM time windows to the start of setup, not the start of service", async () => {
    const arrival = jobStep(await solve(tinyInstance())).arrival;

    const closesAtArrival = await solve(tinyInstance([[0, arrival]]));
    expect(closesAtArrival.unassigned).toEqual([]);
    const step = jobStep(closesAtArrival);
    expect(step.arrival + step.setup).toBeGreaterThan(arrival);

    const closesBeforeArrival = await solve(tinyInstance([[0, arrival - 1]]));
    expect(closesBeforeArrival.unassigned.map((job) => job.id)).toEqual([1]);
  });

  it("reports healthy when the database, OSRM and VROOM all answer", async () => {
    const app = createApp({ db: appPool, routing: createRoutingHealth(stack), config: { serverEpoch: "routing-up" } });
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("reports unavailable when OSRM does not answer", async () => {
    const routing = createRoutingHealth({ osrmUrl: deadUrl, vroomUrl: stack.vroomUrl });
    const response = await createApp({ db: appPool, routing, config: { serverEpoch: "osrm-down" } }).request("/health");
    expect(response.status).toBe(503);
    expect(response.headers.get("X-Server-Epoch")).toBe("osrm-down");
    expect(await response.text()).toBe("");
  });

  it("reports unavailable when VROOM does not answer", async () => {
    const routing = createRoutingHealth({ osrmUrl: stack.osrmUrl, vroomUrl: deadUrl });
    const response = await createApp({ db: appPool, routing, config: { serverEpoch: "vroom-down" } }).request("/health");
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
  });
});
