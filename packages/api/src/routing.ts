import type { Router, RoutingHealth } from "./app.js";
import type { LngLat, VroomSolution, VroomSolver } from "./planner.js";

// A point in San Miguel de Tucumán: /nearest answers only once OSRM has its artifact loaded.
const osrmProbePath = "/nearest/v1/driving/-65.2036,-26.8241";
const OSRM_ROUTE_TIMEOUT_MS = 10_000;

export function createRoutingHealth({ osrmUrl, vroomUrl }: { osrmUrl: string; vroomUrl: string }): RoutingHealth {
  return {
    osrm: (signal) => expectOk(new URL(osrmProbePath, osrmUrl), signal),
    vroom: (signal) => expectOk(new URL("/health", vroomUrl), signal),
  };
}

/** Road legs between consecutive points, in order, from OSRM's /route service: n points give n - 1 legs. */
export function createOsrmRouter(osrmUrl: string): Router {
  return async (points) => {
    const coordinates = points.map((point) => `${point.lng},${point.lat}`).join(";");
    const url = new URL(`/route/v1/driving/${coordinates}?overview=false&steps=false`, osrmUrl);
    const response = await fetch(url, { signal: AbortSignal.timeout(OSRM_ROUTE_TIMEOUT_MS) });
    const body = await response.json().catch(() => null) as { code?: string; routes?: { legs: { distance: number; duration: number }[] }[] } | null;
    const legs = body?.routes?.[0]?.legs;
    if (!response.ok || body?.code !== "Ok" || !legs || legs.length !== points.length - 1) {
      throw new Error(`${url.origin} could not route: ${response.status} ${body?.code ?? "no body"}`);
    }
    return legs.map((leg) => ({ distanceMeters: leg.distance, durationSeconds: leg.duration }));
  };
}

async function expectOk(url: URL, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`${url.origin} answered ${response.status}`);
}

export class RoutingEngineError extends Error {}

/** Posts a problem to VROOM; any failure (no answer, timeout, error status) is a RoutingEngineError. */
export function createVroomSolver({ vroomUrl, timeoutMs = 30_000 }: { vroomUrl: string; timeoutMs?: number }): VroomSolver {
  return async (problem) => {
    let response: Response;
    try {
      response = await fetch(new URL("/", vroomUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(problem),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new RoutingEngineError("VROOM did not answer", { cause: error });
    }
    const body = await response.json().catch(() => null) as (VroomSolution & { error?: string }) | null;
    if (!response.ok || !body || !Array.isArray(body.routes) || !Array.isArray(body.unassigned)) {
      throw new RoutingEngineError(`VROOM answered ${response.status}${body?.error ? `: ${body.error}` : ""}`);
    }
    return body;
  };
}

export type TravelTime = (from: LngLat, to: LngLat) => Promise<number>;

/** Driving seconds between two points from OSRM /route; failures are RoutingEngineErrors. */
export function createTravelTime({ osrmUrl, timeoutMs = 10_000 }: { osrmUrl: string; timeoutMs?: number }): TravelTime {
  return async (from, to) => {
    let response: Response;
    try {
      response = await fetch(new URL(`/route/v1/driving/${from.join(",")};${to.join(",")}?overview=false`, osrmUrl), {
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new RoutingEngineError("OSRM did not answer", { cause: error });
    }
    const body = await response.json().catch(() => null) as { routes?: { duration: number }[] } | null;
    const duration = body?.routes?.[0]?.duration;
    if (!response.ok || typeof duration !== "number") throw new RoutingEngineError(`OSRM answered ${response.status}`);
    return duration;
  };
}
