import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StopActions, type DriverRoute, type DriverStop, type Marking } from "./Days";

// Synthetic data only.
const stop = (kind: "pickup" | "dropoff", transferStatus: string, trasbordo: boolean): DriverStop => ({
  position: kind === "pickup" ? 1 : 2, kind, plannedTime: "08:05", transferId: 3, direction: "entrada", transferStatus,
  place: { name: trasbordo ? "Trasbordo" : "Escuela Sintética", destinationId: trasbordo ? null : 4, address: "-26.8, -65.25", accessNotes: null },
  passenger: { name: "Pasajero Sintético", wheelchair: false, medicalAlert: null }, companions: 0, trasbordo,
});
const route = (stops: DriverStop[]): DriverRoute => ({
  routeId: 9, version: 1, startTime: "06:00", endTime: "18:00", vehiclePlate: "AAA001", status: "en_curso", acknowledgedVersion: 1, stops,
});
const marking = (): Marking => ({
  sending: false, marks: {}, undone: {}, planFetchedAt: "2026-10-23T11:00:00.000Z", handover: null, refusedClose: null, onStart: vi.fn(),
  onClose: vi.fn(), onMark: vi.fn(), onFlush: vi.fn(), onUndo: vi.fn(), onOpenHandover: vi.fn(), onOtherAdult: vi.fn(), onSearch: vi.fn(),
});
const render = (item: DriverStop) => renderToStaticMarkup(<StopActions route={route([item])} stop={item} marking={marking()} />);

describe("Trasbordo in the Chofer app", () => {
  // Regla 1 / Regla 5: the linked Marcas of a Trasbordo are the Oficina's; the app offers no Marca at the point.
  it("offers no Marca at a Trasbordo point and tells the Chofer to call the Oficina, while other Paradas keep theirs", () => {
    const pickup = render(stop("pickup", "planificado", true));
    expect(pickup).toContain("<p>Trasbordo: call the Oficina to record the handover</p>");
    expect(pickup).not.toContain(">Subió</button>");
    const dropoff = render(stop("dropoff", "subio", true));
    expect(dropoff).toContain("<p>Trasbordo: call the Oficina to record the handover</p>");
    expect(dropoff).not.toContain("<button");
    expect(render(stop("pickup", "planificado", false))).toContain(">Subió</button>");
    expect(render(stop("dropoff", "subio", false))).toContain(">Entregado at Escuela Sintética</button>");
  });
});
