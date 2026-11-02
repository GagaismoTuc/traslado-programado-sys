import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AlertList } from "./AlertsPage";
import { UnpublishedTransfers } from "./PlanPage";
import { TrasbordoForm, trasbordoMessage, trasbordoMode } from "./TrasbordoPanel";

// Synthetic data only.
const routes = [{ id: 1, label: "Chofer Sintético 1 06:00-18:00" }, { id: 2, label: "Chofer Sintético 2 06:00-18:00" }];
const point = { lat: -26.8, lng: -65.25, time: "08:00" };
const transfer = (id: number, fields: Record<string, unknown> = {}) => ({
  id, passengerId: 7, passengerName: "Pasajero Sintético", direction: "entrada" as const, destinationName: "Escuela Sintética",
  originDestinationName: null, targetTime: "08:30", exitTime: null, companions: 0, status: "planificado", routeId: 1, ...fields,
});

describe("Trasbordo in the Plan diario", () => {
  // AC4 / Regla 3: the Oficina fixes the place, the time and the two Recorridos of a planned Trasbordo.
  it("offers a planned Trasbordo with its place, time and both Recorridos, and shows each leg ending or starting at the point", () => {
    expect(trasbordoMode(transfer(1))).toBe("planned");
    const form = renderToStaticMarkup(<TrasbordoForm transfer={transfer(1)} mode="planned" routes={routes} />);
    for (const field of ['name="time"', 'name="fromRouteId"', 'name="toRouteId"', 'name="lat"', 'name="lng"']) expect(form).toContain(field);
    expect(form).toContain("<option value=\"2\">Chofer Sintético 2 06:00-18:00</option>");
    const legA = transfer(1, { trasbordo: { stop: "dropoff", ...point }, chainedToTransferId: 2 });
    const legB = transfer(2, { trasbordo: { stop: "pickup", ...point }, routeId: 2 });
    // Neither leg can be planned again.
    expect([trasbordoMode(legA), trasbordoMode(legB)]).toEqual([null, null]);
    expect(renderToStaticMarkup(<UnpublishedTransfers day={{ transfers: [legA, legB], unpublishedTransferIds: [1, 2] }} />)).toContain(
      "<li>08:30 Pasajero Sintético: entrada, home → Trasbordo 08:00</li><li>08:30 Pasajero Sintético: entrada, Trasbordo 08:00 → Escuela Sintética</li>",
    );
  });

  // AC1 / AC2: a Pasajero on board is handed over to another Recorrido's Chofer; the receiving Recorrido may need forcing.
  it("offers the handover of a Pasajero on board and says whether the receiving Recorrido was published", () => {
    expect(trasbordoMode(transfer(1, { status: "subio" }))).toBe("handover");
    expect(trasbordoMode(transfer(2, { status: "subio", trasbordo: { stop: "pickup", ...point } }))).toBe(null);
    const breakdown = renderToStaticMarkup(<TrasbordoForm transfer={transfer(1, { status: "subio" })} mode="handover" routes={routes} />);
    expect(breakdown).toMatch(/<select[^>]*name="routeId"[^>]*required=""|<select[^>]*required=""[^>]*name="routeId"/);
    expect(breakdown).toMatch(/<input[^>]*required=""[^>]*name="lat" value=""/);
    // A planned one is handed over at its planned point unless the Oficina gives another place.
    const planned = renderToStaticMarkup(<TrasbordoForm transfer={transfer(1, { status: "subio", trasbordo: { stop: "dropoff", ...point } })} mode="handover" routes={routes} />);
    expect(planned).toMatch(/<input type="number" step="any" min="-90" max="90" name="lat" value="-26.8"/);
    expect(trasbordoMessage({ version: { version: 2 } })).toBe("Trasbordo recorded. The receiving Recorrido is published as version 2");
    expect(trasbordoMessage({ error: "The Recorrido breaks limits: fix it or publish it with a reason" }))
      .toBe("Trasbordo recorded, but the receiving Recorrido was not published: The Recorrido breaks limits: fix it or publish it with a reason");
  });

  // Regla 1: a Chofer's own Marca at a Trasbordo point reaches the inbox with what to do about it.
  it("tells the Oficina to correct a Chofer's Marca at a Trasbordo point and record the Trasbordo", () => {
    const markup = renderToStaticMarkup(<AlertList alerts={[{
      id: 1, kind: "mark_flagged", createdAt: "2026-10-23T11:02:00.000Z", transferId: 3, routeId: 9, markId: "00000000-0000-4000-8000-000000000001",
      passengerName: "Pasajero Sintético", driverName: "Chofer Sintético", details: { reasons: ["trasbordo_unlinked"] },
      resolution: null,
    }]} />);
    expect(markup).toContain(
      "Marca accepted with a warning for Pasajero Sintético (Chofer Sintético): the Chofer marked it at a Trasbordo point: correct it and record the Trasbordo",
    );
  });
});
