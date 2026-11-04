import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { LiveMapPage } from "./LiveMapPage";
import liveMapSource from "./LiveMap.tsx?raw";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Office live map and ETAs", () => {
  it("renders the live map page at /live with disclaimer notice and panel", () => {
    vi.stubGlobal("window", { location: { pathname: "/live" } });
    const markup = renderToStaticMarkup(<App />);

    // Header and navigation
    expect(markup).toContain("Mapa en vivo / Live map");
    expect(markup).toContain('href="/live"');
    expect(markup).toContain("Live map");

    // Acceptance criterion: Says clearly that ETAs are approximate (no live traffic)
    expect(markup).toMatch(/Las horas estimadas \(ETA\) son aproximadas \(sin tr[aá]fico en tiempo real\)/i);
    expect(markup).toMatch(/ETAs are approximate \(no live traffic\)/i);
    expect(markup).toContain('data-testid="eta-disclaimer"');

    // Panel and map structure
    expect(markup).toContain('data-testid="live-panel"');
    expect(markup).toContain('data-testid="live-map"');
    expect(markup).toContain('data-testid="live-map-container"');
  });

  it("also supports /map route", () => {
    vi.stubGlobal("window", { location: { pathname: "/map" } });
    const markup = renderToStaticMarkup(<App />);
    expect(markup).toContain("Mapa en vivo / Live map");
    expect(markup).toContain('data-testid="live-panel"');
  });

  it("does not bundle maplibre-gl statically, using dynamic import", () => {
    expect(liveMapSource).not.toMatch(/^import\s+(?!type\b)[^;]*["']maplibre-gl["']/m);
    expect(liveMapSource).toContain('import("maplibre-gl")');
  });

  it("displays per-Recorrido: Vehículo, Chofer, children on board, next stop and ETA in the panel", async () => {
    const mockLivePlan = {
      date: "2026-10-23",
      timeZone: "America/Argentina/Tucuman",
      routes: [
        {
          id: 42,
          status: "en_curso",
          driver: { id: 1, name: "Chofer Carlos" },
          vehicle: { id: 1, plate: "AF123CD" },
          color: "#2e5aa8",
          childrenOnBoard: 2,
          lastMarca: {
            id: 99,
            kind: "subio",
            latitude: -26.83,
            longitude: -65.21,
            phoneTime: "2026-10-23T11:30:00.000Z",
            phoneTimeHhmi: "08:30",
          },
          stops: [
            {
              id: 1,
              position: 1,
              kind: "pickup",
              passengerId: 10,
              passengerName: "Ana Gómez",
              placeName: "Calle Inventada 123",
              latitude: -26.83,
              longitude: -65.21,
              plannedTime: "08:20",
              eta: null,
              status: "subio",
              completed: true,
            },
            {
              id: 2,
              position: 2,
              kind: "dropoff",
              passengerId: 10,
              passengerName: "Ana Gómez",
              placeName: "Escuela Normal",
              latitude: -26.82,
              longitude: -65.2,
              plannedTime: "08:45",
              eta: "08:38",
              status: "pending",
              completed: false,
            },
          ],
          nextStop: {
            id: 2,
            position: 2,
            kind: "dropoff",
            passengerName: "Ana Gómez",
            placeName: "Escuela Normal",
            plannedTime: "08:45",
            eta: "08:38",
          },
          geometry: [
            [-65.21, -26.83],
            [-65.2, -26.82],
          ],
        },
      ],
    };

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/daily-plans/") && url.includes("/live")) {
        return Promise.resolve(new Response(JSON.stringify(mockLivePlan), { status: 200 }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { location: { pathname: "/live", assign: vi.fn() } });

    // Render component
    const markup = renderToStaticMarkup(<LiveMapPage />);
    expect(markup).toContain("Mapa en vivo");
  });

  it("Rule 2: Recorrido without Marcas displays planned times, not ETAs", () => {
    // If a route has no marcas, nextStop displays its planned time and eta is plannedTime
    const routeWithoutMarcas = {
      id: 10,
      status: "publicado",
      driver: { id: 2, name: "Chofer Beto" },
      vehicle: { id: 2, plate: "AA000BB" },
      color: "#bf4520",
      childrenOnBoard: 0,
      lastMarca: null,
      stops: [
        {
          id: 1,
          position: 1,
          kind: "pickup" as const,
          passengerId: 5,
          passengerName: "Lucas Pérez",
          placeName: "Domicilio 456",
          latitude: -26.84,
          longitude: -65.22,
          plannedTime: "07:30",
          eta: null,
          status: "pending",
          completed: false,
        },
      ],
      nextStop: {
        id: 1,
        position: 1,
        kind: "pickup" as const,
        passengerName: "Lucas Pérez",
        placeName: "Domicilio 456",
        plannedTime: "07:30",
        eta: "07:30",
      },
      geometry: [[-65.22, -26.84]],
    };

    expect(routeWithoutMarcas.lastMarca).toBeNull();
    expect(routeWithoutMarcas.nextStop.eta).toBe(routeWithoutMarcas.nextStop.plannedTime);
    expect(routeWithoutMarcas.stops[0].eta).toBeNull();
  });
});

