import type { RoutingHealth } from "./app.js";
import type { VroomSolution, VroomSolver } from "./planner.js";

// A point in San Miguel de Tucumán: /nearest answers only once OSRM has its artifact loaded.
const osrmProbePath = "/nearest/v1/driving/-65.2036,-26.8241";

export function createRoutingHealth({ osrmUrl, vroomUrl }: { osrmUrl: string; vroomUrl: string }): RoutingHealth {
  return {
    osrm: (signal) => expectOk(new URL(osrmProbePath, osrmUrl), signal),
    vroom: (signal) => expectOk(new URL("/health", vroomUrl), signal),
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
