import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { IncidentForm, RouteView, type DriverRoute, type DriverStop, type Marking } from "./Days";
import { INCIDENT_KINDS, type IncidentKind } from "./Marks";

const dummyStop: DriverStop = {
  position: 1,
  kind: "pickup",
  plannedTime: "08:00",
  transferId: 10,
  direction: "entrada",
  transferStatus: "planificado",
  place: { name: null, destinationId: null, address: "Calle Falsa 123", accessNotes: null },
  passenger: { name: "Pasajero Sintético", wheelchair: false, medicalAlert: null },
  companions: 0,
};

const dummyRoute = (status: string): DriverRoute => ({
  routeId: 42,
  version: 1,
  startTime: "07:30",
  endTime: "08:30",
  vehiclePlate: "TST001",
  status,
  acknowledgedVersion: 1,
  stops: [dummyStop],
});

const dummyMarking = (fields: Partial<Marking> = {}): Marking => ({
  sending: false,
  marks: {},
  refused: {},
  undone: {},
  planFetchedAt: null,
  handover: null,
  refusedClose: null,
  onStart: vi.fn(),
  onClose: vi.fn(),
  onMark: vi.fn(),
  onFlush: vi.fn(),
  onUndo: vi.fn(),
  onOpenHandover: vi.fn(),
  onOtherAdult: vi.fn(),
  onSearch: vi.fn(),
  onIncident: vi.fn(),
  ...fields,
});

describe("Incident form in driver app", () => {
  it("offers all 5 incident kinds including Pasajero health crisis", () => {
    expect(INCIDENT_KINDS).toEqual([
      { kind: "delay", label: "Delay" },
      { kind: "vehicle_fault", label: "Vehicle fault" },
      { kind: "accident", label: "Accident" },
      { kind: "health_crisis", label: "Pasajero health crisis" },
      { kind: "other", label: "Other" },
    ]);
  });

  it("renders Report incident on en_curso Recorridos", () => {
    const enCursoMarkup = renderToStaticMarkup(
      <RouteView route={dummyRoute("en_curso")} sending={false} onAcknowledge={vi.fn()} marking={dummyMarking()} />,
    );
    expect(enCursoMarkup).toContain("Report incident");

    const cerradoMarkup = renderToStaticMarkup(
      <RouteView route={dummyRoute("cerrado")} sending={false} onAcknowledge={vi.fn()} marking={dummyMarking()} />,
    );
    expect(cerradoMarkup).not.toContain("Report incident");
  });

  it("renders form elements when IncidentForm is opened", () => {
    const markup = renderToStaticMarkup(
      <IncidentForm route={dummyRoute("en_curso")} sending={false} onIncident={vi.fn()} />,
    );
    expect(markup).toContain("<summary>Report incident</summary>");
    expect(markup).toContain("Submit incident");
    expect(markup).toContain("Pasajero health crisis");
  });
});
