import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DestinationsPage } from "./DestinationsPage";
import { DriversPage } from "./DriversPage";
import { VehicleFeaturesPage } from "./VehicleFeaturesPage";
import { VehiclesPage } from "./VehiclesPage";

// Server rendering skips effects; running them inline starts each page's initial load.
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: (effect: () => void) => { effect(); },
}));
vi.mock("./PinPicker", () => ({ PinPicker: () => null }));

afterEach(() => vi.unstubAllGlobals());

const pages: [string, () => ReactElement][] = [
  ["/vehicles", () => <VehiclesPage />],
  ["/drivers", () => <DriversPage />],
  ["/vehicle-features", () => <VehicleFeaturesPage />],
  ["/destinations", () => <DestinationsPage />],
];

async function navigationAfterLoad(page: () => ReactElement, body: unknown) {
  const assign = vi.fn();
  vi.stubGlobal("window", { location: { pathname: "/", assign } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 401 })));
  renderToStaticMarkup(page());
  await vi.waitFor(() => expect(assign).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 0));
  return assign.mock.calls;
}

describe("office fleet and Destinos pages on 401", () => {
  it("send /vehicles, /drivers, /vehicle-features and /destinations to /second-factor on second_factor_required and to / on any other 401", async () => {
    for (const [path, page] of pages) {
      expect(await navigationAfterLoad(page, { error: "Second factor required", code: "second_factor_required" }), path).toEqual([["/second-factor"]]);
      expect(await navigationAfterLoad(page, { error: "Unauthorized" }), path).toEqual([["/"]]);
      expect(await navigationAfterLoad(page, { error: "Session expired", code: "session_expired" }), path).toEqual([["/"]]);
    }
  });
});
