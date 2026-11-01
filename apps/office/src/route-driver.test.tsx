import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { driverChangedMessage, RouteDriverField } from "./PlanPage";

// Synthetic data only.
const drivers = [{ id: 1, name: "Chofer Sintético", usualVehicleId: 10 }, { id: 2, name: "Chofera Sintética", usualVehicleId: null }];

describe("Recorrido editor: Chofer", () => {
  it("lets the Oficina choose another Chofer for a Recorrido that is not En curso", () => {
    const markup = renderToStaticMarkup(<RouteDriverField route={{ driverId: 2, status: "publicado" }} drivers={drivers} onChange={() => undefined} />);
    expect(markup).toBe(
      "<label>Chofer<select><option value=\"1\">Chofer Sintético</option><option value=\"2\" selected=\"\">Chofera Sintética</option></select></label>",
    );
    expect(renderToStaticMarkup(<RouteDriverField route={{ driverId: 1, status: "en_curso" }} drivers={drivers} onChange={() => undefined} />))
      .toContain("<select disabled=\"\">");
  });

  it("warns about the front seat when the Chofer changes, without blocking the change", () => {
    expect(driverChangedMessage({ frontSeat: true }))
      .toBe("Chofer changed. The Recorrido carries a Pasajero who needs the front seat: check it with the new Chofer.");
    expect(driverChangedMessage({ frontSeat: false })).toBe("Chofer changed");
  });
});
