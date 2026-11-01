import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPool } from "../src/db.js";
import { planRoute, type LngLat, type PlanInput, type PlannerSettings, type PlanTransfer } from "../src/planner.js";
import { createRoutingHealth, createVroomSolver } from "../src/routing.js";
import { validateRoute } from "@traslado/shared";
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

// Deterministic pseudo-random numbers (mulberry32), so a failing instance can be replayed.
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, values: T[]) {
  return values[Math.floor(random() * values.length)];
}

// The 5 × 5 nodes of the synthetic grid extract.
function gridNodes(): LngLat[] {
  const nodes: LngLat[] = [];
  for (let lng = 0; lng < 5; lng++) for (let lat = 0; lat < 5; lat++) nodes.push([-65.22 + lng * 0.005, -26.84 + lat * 0.005]);
  return nodes;
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

  it("C2 property test: in hundreds of random instances every assigned Pasajero rides at most R and is picked up before drop-off", async () => {
    const solve = createVroomSolver({ vroomUrl: stack.vroomUrl });
    const random = seeded(21);
    const nodes = gridNodes();
    let placed = 0;
    for (let instance = 0; instance < 300; instance++) {
      const settings: PlannerSettings = {
        rideTimeBufferMinutes: pick(random, [0, 2, 5]),
        speedFactors: [{ fromMinutes: 0, factor: 1 }, { fromMinutes: 12 * 60, factor: pick(random, [0.5, 0.8, 1.5]) }],
        earlyToleranceMinutes: 15,
      };
      const transfers: PlanTransfer[] = Array.from({ length: 1 + Math.floor(random() * 8) }, (_, index) => ({
        id: index + 1,
        direction: random() < 0.5 ? "entrada" : "salida",
        targetMinutes: 7 * 60 + Math.floor(random() * 11 * 60),
        pickup: pick(random, nodes),
        dropoff: pick(random, nodes),
        seats: 1 + Math.floor(random() * 3),
        frontSeat: random() < 0.2,
        requiredFeatureIds: [],
        maxRideMinutes: 15 + Math.floor(random() * 46),
        pickupMinutes: 1 + Math.floor(random() * 5),
        dropoffMinutes: 1 + Math.floor(random() * 5),
      }));
      const input: PlanInput = {
        transfers,
        vehicle: { seats: 4 + Math.floor(random() * 5), featureIds: [] },
        start: pick(random, nodes),
        end: random() < 0.5 ? pick(random, nodes) : null,
        startMinutes: 6 * 60 + Math.floor(random() * 12 * 60),
      };
      const result = await planRoute(input, settings, solve);

      const assigned = new Set(result.stops.map((stop) => stop.transferId));
      expect([...assigned, ...result.unassigned.map((item) => item.transferId)].sort(), `instance ${instance}`)
        .toEqual(transfers.map((transfer) => transfer.id).sort());
      placed += assigned.size;
      const served = transfers.filter((transfer) => assigned.has(transfer.id));
      const violations = validateRoute({
        route: result.stops.map((stop) => ({
          id: `${stop.transferId}-${stop.kind}`, transferId: String(stop.transferId), type: stop.kind, plannedTime: stop.plannedSeconds / 60,
        })),
        passengers: served.map((transfer) => ({
          id: `p${transfer.id}`, maxRideTimeMinutes: transfer.maxRideMinutes, dropoffDurationMinutes: transfer.dropoffMinutes,
        })),
        vehicle: { id: "v", capacity: { seats: 99 } },
        transfers: served.map((transfer) => ({ id: String(transfer.id), passengerId: `p${transfer.id}` })),
      });
      expect(violations.filter((violation) => ["max_ride_time_exceeded", "dropoff_before_pickup", "unserved_transfer"].includes(violation.rule)), `instance ${instance}`)
        .toEqual([]);
    }
    // The instances must exercise the engine, not only the local rejections.
    expect(placed).toBeGreaterThan(300);
  }, 240_000);

  it("Rule 13 example: 12 entradas at 08:00 in a 5-seat Vehículo leave the ones that do not fit unassigned with their reason", async () => {
    const random = seeded(13);
    const nodes = gridNodes();
    const school: LngLat = [-65.2, -26.82];
    const transfers: PlanTransfer[] = Array.from({ length: 12 }, (_, index) => ({
      id: index + 1, direction: "entrada", targetMinutes: 8 * 60, pickup: pick(random, nodes.filter(([lng, lat]) => lng !== school[0] || lat !== school[1])), dropoff: school,
      seats: 1, frontSeat: false, requiredFeatureIds: [], maxRideMinutes: 60, pickupMinutes: 1, dropoffMinutes: 1,
    }));
    const settings: PlannerSettings = { rideTimeBufferMinutes: 5, speedFactors: [], earlyToleranceMinutes: 15 };
    const result = await planRoute(
      { transfers, vehicle: { seats: 5, featureIds: [] }, start: [-65.22, -26.84], end: null, startMinutes: 7 * 60 },
      settings,
      createVroomSolver({ vroomUrl: stack.vroomUrl }),
    );
    const assigned = new Set(result.stops.map((stop) => stop.transferId));
    expect(assigned.size + result.unassigned.length).toBe(12);
    expect(result.unassigned.length).toBeGreaterThan(0);
    for (const item of result.unassigned) expect(["capacity", "time_window"]).toContain(item.reason);
    for (const stop of result.stops.filter((candidate) => candidate.kind === "dropoff")) expect(stop.plannedSeconds).toBeLessThanOrEqual(8 * 3600);
    let aboard = 0;
    for (const stop of result.stops) {
      aboard += stop.kind === "pickup" ? 1 : -1;
      expect(aboard).toBeLessThanOrEqual(5);
    }
  });

  it("reports unavailable when VROOM does not answer", async () => {
    const routing = createRoutingHealth({ osrmUrl: stack.osrmUrl, vroomUrl: deadUrl });
    const response = await createApp({ db: appPool, routing, config: { serverEpoch: "vroom-down" } }).request("/health");
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
  });
});
