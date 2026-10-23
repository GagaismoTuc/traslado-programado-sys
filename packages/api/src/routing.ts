import type { RoutingHealth } from "./app.js";

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
