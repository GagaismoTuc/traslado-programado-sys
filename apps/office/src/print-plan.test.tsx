import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PrintPlanView,
  PrintRefusal,
  PrintRouteSheet,
  formatPublicationTime,
  type PrintRoute,
  type UnpublishedTransfer,
} from "./PrintPlanPage";
import { PlanPage } from "./PlanPage";

afterEach(() => {
  vi.unstubAllGlobals();
});

// Synthetic test data only.
const sampleRoute: PrintRoute = {
  routeId: 10,
  version: 3,
  publishedAt: "2026-11-01T20:30:00.000Z",
  startTime: "07:30",
  endTime: "09:00",
  driver: { id: 1, name: "Chofer Sintético" },
  vehicle: { id: 2, plate: "AF123ZZ", model: "Furgón Sintético" },
  stops: [
    {
      position: 1,
      kind: "pickup",
      plannedTime: "07:35",
      transferId: 101,
      direction: "entrada",
      passengerName: "Pasajero Sintético 1",
      companions: 1,
      wheelchair: true,
      medicalAlert: "Epilepsia",
      accessNotes: "Timbre blanco",
      destinationName: "Escuela Especial Sintética",
      placeName: "Domicilio",
      address: "Calle Falsa 123",
    },
    {
      position: 2,
      kind: "pickup",
      plannedTime: "07:50",
      transferId: 102,
      direction: "entrada",
      passengerName: "Pasajero Sintético 2",
      companions: 0,
      wheelchair: false,
      medicalAlert: null,
      accessNotes: null,
      destinationName: "Escuela Especial Sintética",
      placeName: "Domicilio",
      address: "Avenida Principal 456",
    },
    {
      position: 3,
      kind: "dropoff",
      plannedTime: "08:15",
      transferId: 101,
      direction: "entrada",
      passengerName: "Pasajero Sintético 1",
      companions: 1,
      wheelchair: true,
      medicalAlert: "Epilepsia",
      accessNotes: "Rampa lateral",
      destinationName: "Escuela Especial Sintética",
      placeName: "Escuela Especial Sintética",
      address: "Boulevard Educativo 789",
    },
    {
      position: 4,
      kind: "dropoff",
      plannedTime: "08:20",
      transferId: 102,
      direction: "entrada",
      passengerName: "Pasajero Sintético 2",
      companions: 0,
      wheelchair: false,
      medicalAlert: null,
      accessNotes: "Rampa lateral",
      destinationName: "Escuela Especial Sintética",
      placeName: "Escuela Especial Sintética",
      address: "Boulevard Educativo 789",
    },
  ],
};

const unpublishedSample: UnpublishedTransfer[] = [
  {
    id: 201,
    passengerName: "Pasajero Sin Recorrido 1",
    direction: "entrada",
    destinationName: "Centro Terapéutico Sintético",
    targetTime: "08:30",
    label: "08:30 Pasajero Sin Recorrido 1: entrada → Centro Terapéutico Sintético",
  },
  {
    id: 202,
    passengerName: "Pasajero Sin Recorrido 2",
    direction: "salida",
    destinationName: "Escuela Sintética",
    targetTime: "12:00",
    label: "12:00 Pasajero Sin Recorrido 2: salida → Escuela Sintética",
  },
];

describe("Print / export Plan diario", () => {
  it("renders printable view per Recorrido with Chofer, Vehículo, version, publication time and ordered stops", () => {
    const markup = renderToStaticMarkup(
      <PrintRouteSheet route={sampleRoute} date="2026-11-02" timeZone="America/Argentina/Tucuman" />,
    );

    // One page per Recorrido CSS class
    expect(markup).toContain('class="print-route-page"');

    // Header info: Chofer, Vehículo, version number (Regla 2), publication time (Regla 2)
    expect(markup).toContain("Chofer Sintético");
    expect(markup).toContain("AF123ZZ");
    expect(markup).toContain("Furgón Sintético");
    expect(markup).toContain("Versión:</strong> 3");
    const formatted = formatPublicationTime(sampleRoute.publishedAt, "America/Argentina/Tucuman");
    expect(formatted).toContain("17:30");
    expect(formatted).toContain("01/11/2026");
    expect(markup).toContain(`(Publicado: ${formatted})`);

    // Ordered stops with planned times, Pasajeros, Acompañante, wheelchair, access notes, medical alert, Destino
    expect(markup).toContain("Pasajero Sintético 1");
    expect(markup).toContain("Pasajero Sintético 2");
    expect(markup).toContain("07:35");
    expect(markup).toContain("08:15");
    expect(markup).toContain("Epilepsia");
    expect(markup).toContain("Timbre blanco");
    expect(markup).toContain("Escuela Especial Sintética");
    expect(markup).toContain("Rampa lateral");
    expect(markup).toContain("Subida");
    expect(markup).toContain("Bajada");
  });

  it("renders refusal naming every unpublished Traslado when the day view lists any without a published Recorrido", () => {
    const markup = renderToStaticMarkup(
      <PrintRefusal
        error="The Plan diario cannot be printed: some Traslados have no published Recorrido"
        unpublishedTransfers={unpublishedSample}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('data-testid="print-refusal"');
    expect(markup).toContain("The Plan diario cannot be printed: some Traslados have no published Recorrido");
    expect(markup).toContain("Pasajero Sin Recorrido 1: entrada → Centro Terapéutico Sintético");
    expect(markup).toContain("Pasajero Sin Recorrido 2: salida → Escuela Sintética");
  });

  it("renders export to PDF / print button and multiple Recorridos in the whole day view", () => {
    const secondRoute: PrintRoute = {
      ...sampleRoute,
      routeId: 11,
      version: 1,
      startTime: "13:30",
      endTime: "15:00",
      stops: [],
    };

    const markup = renderToStaticMarkup(
      <PrintPlanView plan={{ date: "2026-11-02", timeZone: "America/Argentina/Tucuman" }} routes={[sampleRoute, secondRoute]} />,
    );

    expect(markup).toContain("Export to PDF / Print");
    expect(markup).toContain("data-testid=\"print-route-10\"");
    expect(markup).toContain("data-testid=\"print-route-11\"");
  });

  it("activates browser print when clicking the Export to PDF / Print button", () => {
    const printMock = vi.fn();
    vi.stubGlobal("window", { print: printMock });

    const view = PrintPlanView({
      plan: { date: "2026-11-02", timeZone: "America/Argentina/Tucuman" },
      routes: [sampleRoute],
    });

    const toolbar = view.props.children[0];
    const button = toolbar.props.children[0];
    expect(button.props.children).toBe("Export to PDF / Print");

    button.props.onClick();
    expect(printMock).toHaveBeenCalledTimes(1);

    const customPrint = vi.fn();
    const customView = PrintPlanView({
      plan: { date: "2026-11-02", timeZone: "America/Argentina/Tucuman" },
      routes: [sampleRoute],
      onPrint: customPrint,
    });
    const customButton = customView.props.children[0].props.children[0];
    customButton.props.onClick();
    expect(customPrint).toHaveBeenCalledTimes(1);
  });

  it("navigates back to PlanPage preserving a date parameter different from today", () => {
    vi.stubGlobal("window", {
      location: {
        search: "?date=2026-11-15",
      },
    });

    const markup = renderToStaticMarkup(<PlanPage />);
    expect(markup).toContain('value="2026-11-15"');
  });
});
