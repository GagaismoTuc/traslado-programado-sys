import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { LIVE_REFRESH_MS, LiveMapPage, PassengerSearch, startTrailRefresh } from "./LiveMapPage";
import type { LiveRoute } from "@traslado/api";
import type { TrailPoint } from "./api";
import {
  applyFollowCenter,
  bindManualMoveStop,
  createMarcaPopupContent,
  createStopPopupContent,
  dayPassengers,
  filterPassengers,
  followTarget,
  updateMapRoutes,
  updateMapTrail,
} from "./LiveMap";
import liveMapSource from "./LiveMap.tsx?raw";
import secondFactorSource from "./SecondFactor.tsx?raw";

afterEach(() => {
  vi.useRealTimers();
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

  it("prevents stored XSS in map popups by using textContent and safe DOM nodes", () => {
    class MockElement {
      tagName: string;
      className = "";
      style: Record<string, string> = {};
      _text = "";
      children: (MockElement | MockTextNode)[] = [];

      constructor(tag: string) {
        this.tagName = tag.toUpperCase();
      }

      set textContent(val: string) {
        this._text = val;
        this.children = [];
      }

      get textContent(): string {
        return this._text + this.children.map((c) => c.textContent).join("");
      }

      appendChild(child: MockElement | MockTextNode) {
        this.children.push(child);
        return child;
      }

      querySelector(selector: string): MockElement | null {
        const target = selector.toUpperCase();
        for (const child of this.children) {
          if ("tagName" in child) {
            if (child.tagName === target) return child;
            const found = child.querySelector(selector);
            if (found) return found;
          }
        }
        return null;
      }
    }

    class MockTextNode {
      nodeType = 3;
      textContent: string;
      constructor(text: string) {
        this.textContent = text;
      }
    }

    const mockDocument = {
      createElement: (tag: string) => new MockElement(tag),
      createTextNode: (text: string) => new MockTextNode(text),
    };
    vi.stubGlobal("document", mockDocument);

    const maliciousStop = {
      id: 1,
      position: 1,
      kind: "pickup" as const,
      passengerId: 10,
      passengerName: '<svg onload="window.xss=1"></svg>',
      placeName: '"><script>alert(1)</script>',
      latitude: -26.83,
      longitude: -65.21,
      plannedTime: "08:20",
      eta: null,
      status: "pending",
      completed: false,
    };
    const popup = createStopPopupContent(maliciousStop as any) as any;
    expect(popup.querySelector("svg")).toBeNull();
    expect(popup.querySelector("script")).toBeNull();
    expect(popup.textContent).toContain('<svg onload="window.xss=1"></svg>');
    expect(popup.textContent).toContain('"><script>alert(1)</script>');

    const marcaPopup = createMarcaPopupContent(
      "<img src=x onerror=alert(1)>",
      "<svg/onload=alert(2)>",
      "subio",
      "08:30",
    ) as any;
    expect(marcaPopup.querySelector("img")).toBeNull();
    expect(marcaPopup.querySelector("svg")).toBeNull();
    expect(marcaPopup.textContent).toContain("<img src=x onerror=alert(1)>");

    // Ensure no raw innerHTML interpolation remains in LiveMap.tsx
    expect(liveMapSource).not.toMatch(/popupContent\.innerHTML\s*=/);
    expect(liveMapSource).not.toMatch(/marcaPopup\.innerHTML\s*=/);
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
          passengersOnBoard: [{ id: 10, name: "Ana Gómez" }, { id: 11, name: "Bruno Díaz" }],
          lastMarca: {
            id: 99,
            kind: "subio",
            latitude: -26.83,
            longitude: -65.21,
            phoneTime: "2026-10-23T11:30:00.000Z",
            phoneTimeHhmi: "08:30",
          },
          currentPosition: {
            source: "marca" as const,
            latitude: -26.83,
            longitude: -65.21,
            phoneTime: "2026-10-23T11:30:00.000Z",
            phoneTimeHhmi: "08:30",
            accuracyMeters: null,
          },
          stops: [
            {
              id: 1,
              position: 1,
              transferId: 1,
              targetTime: "08:00",
              delivered: null,
              kind: "pickup" as const,
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
              transferId: 1,
              targetTime: "08:00",
              delivered: null,
              kind: "dropoff" as const,
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
            kind: "dropoff" as const,
            passengerName: "Ana Gómez",
            placeName: "Escuela Normal",
            plannedTime: "08:45",
            eta: "08:38",
          },
          geometry: [
            [-65.21, -26.83],
            [-65.2, -26.82],
          ] as [number, number][],
        },
      ],
    };

    // Render component with data
    const markup = renderToStaticMarkup(<LiveMapPage initialData={mockLivePlan} />);
    expect(markup).toContain("Mapa en vivo");
    expect(markup).toContain("AF123CD");
    expect(markup).toContain("Chofer Carlos");
    expect(markup).toContain('data-testid="route-boarded-42">2</span>');
    expect(markup).toContain("Ana Gómez (Bajada) - Escuela Normal");
    expect(markup).toContain('data-testid="route-eta-42"');
    expect(markup).toContain("08:38");
    expect(markup).toContain("Última marca: subio a las 08:30");
  });

  it("Rule 2: Recorrido without Marcas displays planned times, not ETAs on the screen", () => {
    const routeWithoutMarcas = {
      id: 10,
      status: "publicado",
      driver: { id: 2, name: "Chofer Beto" },
      vehicle: { id: 2, plate: "AA000BB" },
      color: "#bf4520",
      childrenOnBoard: 0,
      passengersOnBoard: [],
      lastMarca: null,
      currentPosition: null,
      stops: [
        {
          id: 1,
          position: 1,
          transferId: 1,
          targetTime: "08:00",
          delivered: null,
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
        eta: null,
      },
      geometry: [[-65.22, -26.84]] as [number, number][],
    };

    const planWithoutMarcas = {
      date: "2026-10-23",
      timeZone: "America/Argentina/Tucuman",
      routes: [routeWithoutMarcas],
    };

    const markup = renderToStaticMarkup(<LiveMapPage initialData={planWithoutMarcas} />);

    // Screen displays route header, vehicle and driver
    expect(markup).toContain("Recorrido #10");
    expect(markup).toContain("AA000BB");
    expect(markup).toContain("Chofer Beto");
    expect(markup).toContain('data-testid="route-boarded-10">0</span>');

    // Rule 2 assertion: next stop shows planned time without labelling it as ETA
    expect(markup).toContain('data-testid="route-eta-10"');
    expect(markup).toContain("Hora planificada:");
    expect(markup).not.toMatch(/<strong>ETA:<\/strong>\s*<span[^>]*>07:30/);

    // Route has no marcas, so no "Última marca" label is shown
    expect(markup).not.toContain("Última marca:");

    // Stop item shows planned time without ETA
    expect(markup).toContain("Planificada: 07:30");
    expect(markup).not.toMatch(/Planificada:\s*07:30\s*\|\s*ETA:/);
  });

  it("SecondFactor redirects office users to /live upon success and does not direct to /users", () => {
    expect(secondFactorSource).not.toContain('window.location.assign("/users")');
    expect(secondFactorSource).toContain('window.location.assign("/live")');
  });

  it("Regla 1 & 2: displays 'No disponible' for ETA when mark has no GPS or router fails", () => {
    const routeWithFailedEta = {
      id: 20,
      status: "en_curso",
      driver: { id: 3, name: "Chofer Sin GPS" },
      vehicle: { id: 3, plate: "CC111DD" },
      color: "#198754",
      childrenOnBoard: 1,
      passengersOnBoard: [{ id: 5, name: "Lucas Pérez" }],
      lastMarca: {
        id: 5,
        kind: "subio",
        latitude: null,
        longitude: null,
        phoneTime: "2026-10-23T11:30:00.000Z",
        phoneTimeHhmi: "08:30",
      },
      currentPosition: null,
      stops: [
        {
          id: 1,
          position: 1,
          transferId: 1,
          targetTime: "08:00",
          delivered: null,
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
        eta: null,
      },
      geometry: [[-65.22, -26.84]] as [number, number][],
    };

    const markup = renderToStaticMarkup(
      <LiveMapPage initialData={{ date: "2026-10-23", timeZone: "America/Argentina/Tucuman", routes: [routeWithFailedEta] }} />,
    );

    expect(markup).toContain("Recorrido #20");
    expect(markup).toContain('data-testid="route-eta-20"');
    expect(markup).toContain("No disponible");
    expect(markup).toContain("Planificada: 07:30");
    expect(markup).toContain("no disponible");
  });

  it("does not label a planned time as ETA without a mark", () => {
    const stop = { id: 1, position: 1, transferId: 1, targetTime: "08:00", delivered: null, kind: "pickup" as const, passengerId: 1, passengerName: "Synthetic", placeName: "Synthetic", latitude: 0, longitude: 0, plannedTime: "08:55", eta: null, status: "pending", completed: false };
    const route = { id: 1, status: "planned", driver: { id: 1, name: "Synthetic" }, vehicle: { id: 1, plate: "TEST" }, color: "#000", childrenOnBoard: 0, passengersOnBoard: [], lastMarca: null, currentPosition: null, stops: [stop], nextStop: { ...stop, eta: "08:55" }, geometry: [] as [number, number][] };
    const html = renderToStaticMarkup(<LiveMapPage initialData={{ date: "2026-10-23", timeZone: "America/Argentina/Tucuman", routes: [route] }} />);
    expect(html).not.toMatch(/<strong>ETA:<\/strong>\s*<span[^>]*>08:55/);
    expect(html).toContain("Hora planificada:");
    expect(html).toContain("08:55");
  });

  function createMockMap() {
    const mockDocument = {
      createElement: () => ({
        style: {},
        classList: { add: vi.fn() },
        appendChild: vi.fn(),
      }),
      createTextNode: (text: string) => ({ textContent: text }),
    };
    vi.stubGlobal("document", mockDocument);

    const layers = new Map<string, any>();
    const sources = new Map<string, any>();
    const map = {
      getLayer: (id: string) => layers.get(id),
      removeLayer: vi.fn((id: string) => { layers.delete(id); }),
      addLayer: vi.fn((layer: any) => { layers.set(layer.id, layer); }),
      getSource: (id: string) => sources.get(id),
      removeSource: vi.fn((id: string) => { sources.delete(id); }),
      addSource: vi.fn((id: string, source: any) => { sources.set(id, source); }),
      setPaintProperty: vi.fn(),
    };

    const createdMarkers: { element?: HTMLElement; lngLat?: [number, number]; removed: boolean; remove: () => void }[] = [];
    class MockMarker {
      element?: HTMLElement;
      lngLat?: [number, number];
      removed = false;
      constructor(options?: { element?: HTMLElement }) {
        this.element = options?.element;
        createdMarkers.push(this);
      }
      setLngLat(coords: [number, number]) {
        this.lngLat = coords;
        return this;
      }
      setPopup() {
        return this;
      }
      addTo() {
        return this;
      }
      remove() {
        this.removed = true;
      }
    }

    class MockPopup {
      setDOMContent() {
        return this;
      }
    }

    const library = { Marker: MockMarker as any, Popup: MockPopup as any };
    return { map, library, layers, sources, createdMarkers };
  }

  it("Regla 1: a Marca without GPS does not draw a vehicle marker on the map", () => {
    const { map, library, createdMarkers } = createMockMap();
    const routeWithoutGps = {
      id: 10,
      status: "en_curso",
      driver: { id: 1, name: "Chofer Sin GPS" },
      vehicle: { id: 1, plate: "NO-GPS" },
      color: "#ff0000",
      childrenOnBoard: 0,
      passengersOnBoard: [],
      lastMarca: {
        id: 99,
        kind: "subio",
        latitude: null,
        longitude: null,
        phoneTime: "2026-10-23T11:00:00Z",
        phoneTimeHhmi: "08:00",
      },
      currentPosition: null,
      stops: [
        {
          id: 1,
          position: 1,
          transferId: 1,
          targetTime: "08:00",
          delivered: null,
          kind: "pickup" as const,
          passengerId: 1,
          passengerName: "Pasajero",
          placeName: "Parada 1",
          latitude: -26.82,
          longitude: -65.20,
          plannedTime: "07:30",
          eta: null,
          status: "pending",
          completed: false,
        },
      ],
      nextStop: null,
      geometry: [[-65.20, -26.82], [-65.21, -26.83]] as [number, number][],
    };

    const markersRef = { current: [] };
    const renderedRouteIdsRef = { current: new Set<number>() };

    updateMapRoutes(map, library, [routeWithoutGps], null, markersRef, renderedRouteIdsRef);

    // Only 1 stop marker should be added; NO vehicle marker
    expect(markersRef.current).toHaveLength(1);
    const hasVehicleMarker = createdMarkers.some((m) => m.element?.className === "live-vehicle-marker");
    expect(hasVehicleMarker).toBe(false);
    expect(createdMarkers[0].element?.className).toBe("live-stop-marker");
  });

  it("Regla 3: cleans up layers, sources and markers when changing to a day without routes", () => {
    const { map, library, layers, sources, createdMarkers } = createMockMap();
    const route = {
      id: 42,
      status: "en_curso",
      driver: { id: 1, name: "Chofer" },
      vehicle: { id: 1, plate: "ABC123" },
      color: "#00ff00",
      childrenOnBoard: 0,
      passengersOnBoard: [],
      lastMarca: {
        id: 1,
        kind: "subio",
        latitude: -26.82,
        longitude: -65.20,
        phoneTime: "2026-10-23T11:00:00Z",
        phoneTimeHhmi: "08:00",
      },
      currentPosition: {
        source: "marca" as const,
        latitude: -26.82,
        longitude: -65.20,
        phoneTime: "2026-10-23T11:00:00Z",
        phoneTimeHhmi: "08:00",
        accuracyMeters: null,
      },
      stops: [
        {
          id: 1,
          position: 1,
          transferId: 1,
          targetTime: "08:00",
          delivered: null,
          kind: "pickup" as const,
          passengerId: 1,
          passengerName: "Pasajero",
          placeName: "Parada 1",
          latitude: -26.82,
          longitude: -65.20,
          plannedTime: "08:00",
          eta: null,
          status: "pending",
          completed: false,
        },
      ],
      nextStop: null,
      geometry: [[-65.20, -26.82], [-65.21, -26.83]] as [number, number][],
    };

    const markersRef = { current: [] };
    const renderedRouteIdsRef = { current: new Set<number>() };

    // Initial render with route 42
    updateMapRoutes(map, library, [route], null, markersRef, renderedRouteIdsRef);
    expect(layers.has("route-layer-42")).toBe(true);
    expect(sources.has("route-line-42")).toBe(true);
    expect(markersRef.current).toHaveLength(2); // 1 stop marker + 1 vehicle marker

    // Update with empty routes (e.g. changing to a day with no routes)
    updateMapRoutes(map, library, [], null, markersRef, renderedRouteIdsRef);

    expect(map.removeLayer).toHaveBeenCalledWith("route-layer-42");
    expect(map.removeSource).toHaveBeenCalledWith("route-line-42");
    expect(layers.has("route-layer-42")).toBe(false);
    expect(sources.has("route-line-42")).toBe(false);
    expect(markersRef.current).toHaveLength(0);
    expect(createdMarkers.every((m) => m.removed)).toBe(true);
  });
  function issue135Route(overrides: Partial<LiveRoute> = {}): LiveRoute {
    return {
      id: 7,
      status: "en_curso",
      driver: { id: 1, name: "Chofer Sintético" },
      vehicle: { id: 1, plate: "SIN135" },
      color: "#2e5aa8",
      childrenOnBoard: 0,
      passengersOnBoard: [],
      lastMarca: null,
      currentPosition: null,
      stops: [
        {
          id: 1,
          position: 1,
          transferId: 1,
          targetTime: "08:00",
          delivered: null,
          kind: "dropoff",
          passengerId: 1,
          passengerName: "Pasajero Sintético",
          placeName: "Escuela Sintética",
          latitude: -26.82,
          longitude: -65.2,
          plannedTime: "08:45",
          eta: "08:18",
          status: "pending",
          completed: false,
        },
      ],
      nextStop: { id: 1, position: 1, kind: "dropoff", passengerName: "Pasajero Sintético", placeName: "Escuela Sintética", plannedTime: "08:45", eta: "08:18" },
      geometry: [[-65.21, -26.83], [-65.2, -26.82]],
      ...overrides,
    };
  }

  function renderPanel(route: LiveRoute) {
    return renderToStaticMarkup(<LiveMapPage initialData={{ date: "2026-10-23", timeZone: "America/Argentina/Tucuman", routes: [route] }} />);
  }

  function vehicleMarkers(route: LiveRoute) {
    const { map, library, createdMarkers } = createMockMap();
    updateMapRoutes(map, library, [route], null, { current: [] }, { current: new Set<number>() });
    return createdMarkers.filter((m) => m.element?.className === "live-vehicle-marker");
  }

  it("Regla 1: draws the vehicle marker at the phone's Posición, labelled Celular with its time, and shows its ETA", () => {
    const route = issue135Route({
      lastMarca: { id: 1, kind: "subio", latitude: -26.83, longitude: -65.21, phoneTime: "2026-10-23T11:10:00.000Z", phoneTimeHhmi: "08:10" },
      currentPosition: { source: "posicion", latitude: -26.8, longitude: -65.18, phoneTime: "2026-10-23T11:12:00.000Z", phoneTimeHhmi: "08:12", accuracyMeters: 15 },
    });

    const markers = vehicleMarkers(route);
    expect(markers).toHaveLength(1);
    expect(markers[0].lngLat).toEqual([-65.18, -26.8]);

    const markup = renderPanel(route);
    expect(markup).toContain('data-testid="route-position-7">Celular, 08:12</span>');
    expect(markup).toMatch(/<strong>ETA:<\/strong>\s*<span[^>]*>08:18/);
  });

  it("shows the ETA from a Posición when the Recorrido has no Marcas yet", () => {
    const markup = renderPanel(issue135Route({
      currentPosition: { source: "posicion", latitude: -26.8, longitude: -65.18, phoneTime: "2026-10-23T11:12:00.000Z", phoneTimeHhmi: "08:12", accuracyMeters: 15 },
    }));
    expect(markup).toMatch(/<strong>ETA:<\/strong>\s*<span[^>]*>08:18/);
    expect(markup).not.toContain("Hora planificada:");
  });

  it("Regla 2: labels a position taken from a Marca as Última marca with its time", () => {
    const route = issue135Route({
      lastMarca: { id: 2, kind: "entregado", latitude: -26.82, longitude: -65.2, phoneTime: "2026-10-23T11:14:00.000Z", phoneTimeHhmi: "08:14" },
      currentPosition: { source: "marca", latitude: -26.82, longitude: -65.2, phoneTime: "2026-10-23T11:14:00.000Z", phoneTimeHhmi: "08:14", accuracyMeters: null },
    });

    expect(vehicleMarkers(route)[0].lngLat).toEqual([-65.2, -26.82]);
    expect(renderPanel(route)).toContain('data-testid="route-position-7">Última marca, 08:14</span>');
  });

  it("Regla 3: without a current position there is no vehicle marker, no position label and no ETA", () => {
    const route = issue135Route({
      lastMarca: { id: 3, kind: "subio", latitude: null, longitude: null, phoneTime: "2026-10-23T11:10:00.000Z", phoneTimeHhmi: "08:10" },
      currentPosition: null,
      stops: [{ ...issue135Route().stops[0], eta: null }],
      nextStop: { ...issue135Route().nextStop!, eta: null },
    });

    expect(vehicleMarkers(route)).toEqual([]);
    const markup = renderPanel(route);
    expect(markup).not.toContain('data-testid="route-position-7"');
    expect(markup).toContain("No disponible");
  });

  it("Regla 8: lists the Pasajeros on board by name next to their count", () => {
    const markup = renderPanel(issue135Route({
      childrenOnBoard: 2,
      passengersOnBoard: [{ id: 2, name: "Pasajero Sintético 2" }, { id: 3, name: "Pasajero Sintético 3" }],
    }));
    expect(markup).toContain('data-testid="route-boarded-7">2</span>');
    expect(markup).toContain('data-testid="route-boarded-names-7">Pasajero Sintético 2, Pasajero Sintético 3</span>');
  });
  // Issue #139. Synthetic data only; the fixed clock is 2026-10-23T11:20:00Z (08:20 in Tucumán).
  const NOW = "2026-10-23T11:20:00.000Z";
  const secondsAgo = (s: number) => new Date(Date.parse(NOW) - s * 1000).toISOString();
  const posicion = (phoneTime: string) => ({ source: "posicion" as const, latitude: -26.8, longitude: -65.18, phoneTime, phoneTimeHhmi: "08:17", accuracyMeters: 10 });
  const GRAY = "#6c757d";
  const trailPoints: TrailPoint[] = [
    { lat: -26.83, lng: -65.21, phoneTime: "2026-10-23T11:00:00.000Z" },
    { lat: -26.82, lng: -65.2, phoneTime: "2026-10-23T11:05:00.000Z" },
    { lat: -26.81, lng: -65.19, phoneTime: "2026-10-23T11:10:00.000Z" },
  ];

  it("Regla 3: labels a Posición by its age, en vivo up to 60 s, hace N s up to 2 min, then stale with a gray marker", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const cases: [number, string, boolean][] = [
      [60, "en vivo", false],
      [61, "hace 61 s", false],
      [120, "hace 120 s", false],
      [121, "sin posición desde 08:17", true],
    ];
    for (const [age, label, stale] of cases) {
      const route = issue135Route({ currentPosition: posicion(secondsAgo(age)) });
      expect(renderPanel(route)).toContain(`data-testid="route-age-7">${label}</span>`);
      const marker = vehicleMarkers(route)[0];
      expect(marker.element?.style.backgroundColor).toBe(stale ? GRAY : "#2e5aa8");
      expect(marker.element?.title).toContain(label);
    }
  });

  it("Regla 4: a phone time in the future counts as age 0, en vivo", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const route = issue135Route({ currentPosition: posicion(secondsAgo(-300)) });
    expect(renderPanel(route)).toContain('data-testid="route-age-7">en vivo</span>');
    expect(vehicleMarkers(route)[0].element?.style.backgroundColor).toBe("#2e5aa8");
  });

  it("Regla 5: a position from a Marca keeps Última marca, HH:MM and shows no age", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const route = issue135Route({
      currentPosition: { source: "marca", latitude: -26.82, longitude: -65.2, phoneTime: secondsAgo(600), phoneTimeHhmi: "08:10", accuracyMeters: null },
    });
    const markup = renderPanel(route);
    expect(markup).toContain('data-testid="route-position-7">Última marca, 08:10</span>');
    expect(markup).not.toContain('data-testid="route-age-7"');
    expect(markup).not.toContain("sin posición desde");
    expect(vehicleMarkers(route)[0].element?.style.backgroundColor).toBe("#2e5aa8");
  });

  it("Regla 6: a closed Recorrido shows its whole Rastro and no age label", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const route = issue135Route({ status: "cerrado", currentPosition: posicion(secondsAgo(3600)) });
    const markup = renderPanel(route);
    expect(markup).not.toContain('data-testid="route-age-7"');
    expect(markup).not.toContain("sin posición desde");
    expect(vehicleMarkers(route)[0].element?.style.backgroundColor).toBe("#2e5aa8");

    const { map, layers, sources } = createMockMap();
    updateMapTrail(map, [route], { routeId: 7, points: trailPoints }, { current: null });
    expect(layers.get("route-trail-layer-7")?.paint["line-color"]).toBe("#2e5aa8");
    expect(sources.get("route-trail-7")?.data.geometry.coordinates).toEqual([[-65.21, -26.83], [-65.2, -26.82], [-65.19, -26.81]]);
  });

  it("Criterio 1: draws the chosen Recorrido's Rastro as a solid line in its color, apart from the dashed planned line", () => {
    const { map, library, layers, sources } = createMockMap();
    const route = issue135Route();
    updateMapRoutes(map, library, [route], 7, { current: [] }, { current: new Set<number>() });
    updateMapTrail(map, [route], { routeId: 7, points: trailPoints }, { current: null });

    const planned = layers.get("route-layer-7");
    const trail = layers.get("route-trail-layer-7");
    expect(planned.paint["line-dasharray"]).toEqual([2, 2]);
    expect(trail.type).toBe("line");
    expect(trail.source).toBe("route-trail-7");
    expect(trail.paint["line-color"]).toBe("#2e5aa8");
    expect(trail.paint["line-dasharray"]).toBeUndefined();
    expect(sources.get("route-trail-7")?.data.geometry).toEqual({
      type: "LineString",
      coordinates: [[-65.21, -26.83], [-65.2, -26.82], [-65.19, -26.81]],
    });
  });

  it("Criterio 3: refetches the Rastro on every 15 s map refresh until the selection ends", async () => {
    vi.useFakeTimers();
    const fetchTrail = vi.fn(async () => trailPoints);
    const onTrail = vi.fn();
    const stop = startTrailRefresh(7, fetchTrail, onTrail);
    expect(LIVE_REFRESH_MS).toBe(15_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchTrail).toHaveBeenCalledTimes(1);
    expect(fetchTrail).toHaveBeenCalledWith(7);
    expect(onTrail).toHaveBeenLastCalledWith({ routeId: 7, points: trailPoints });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(fetchTrail).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchTrail).toHaveBeenCalledTimes(2);
    expect(onTrail).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchTrail).toHaveBeenCalledTimes(2);
  });

  it("Regla 7: changing the date or the chosen Recorrido removes the previous Rastro, and a late answer for it is not drawn", async () => {
    const { map, layers, sources } = createMockMap();
    const first = issue135Route();
    const second = issue135Route({ id: 8, color: "#bf4520" });
    const renderedTrail = { current: null as number | null };

    updateMapTrail(map, [first, second], { routeId: 7, points: trailPoints }, renderedTrail);
    expect(layers.has("route-trail-layer-7")).toBe(true);

    // Another Recorrido chosen: Recorrido 7's Rastro leaves the map.
    updateMapTrail(map, [first, second], { routeId: 8, points: trailPoints }, renderedTrail);
    expect(layers.has("route-trail-layer-7")).toBe(false);
    expect(sources.has("route-trail-7")).toBe(false);
    expect(layers.get("route-trail-layer-8")?.paint["line-color"]).toBe("#bf4520");

    // Date changed (no Recorrido chosen): no Rastro remains.
    updateMapTrail(map, [], null, renderedTrail);
    expect(layers.has("route-trail-layer-8")).toBe(false);
    expect(sources.has("route-trail-8")).toBe(false);

    // A late answer for the previous selection is dropped once it ends.
    let answer: (points: TrailPoint[]) => void = () => {};
    const onTrail = vi.fn();
    const stop = startTrailRefresh(7, () => new Promise<TrailPoint[]>((resolve) => { answer = resolve; }), onTrail);
    stop();
    answer(trailPoints);
    await Promise.resolve();
    await Promise.resolve();
    expect(onTrail).not.toHaveBeenCalled();
  });

  // Issue #140. Synthetic data only.
  const at = (latitude: number, longitude: number) => ({ source: "posicion" as const, latitude, longitude, phoneTime: NOW, phoneTimeHhmi: "08:20", accuracyMeters: 10 });
  const stop140 = (overrides: Partial<LiveRoute["stops"][number]>): LiveRoute["stops"][number] => ({
    ...issue135Route().stops[0],
    passengerId: 30,
    passengerName: "José Sintético",
    ...overrides,
  });
  const followMap = () => {
    const handlers = new Map<string, (event: any) => void>();
    return {
      handlers,
      easeTo: vi.fn(),
      on: vi.fn((type: string, handler: (event: any) => void) => { handlers.set(type, handler); }),
      off: vi.fn((type: string) => { handlers.delete(type); }),
    };
  };

  it("#140 Regla 1: following a Recorrido centers the map on its position on every refresh; without a position the map does not move and the label says Sin posición todavía", () => {
    const map = followMap();
    const first = followTarget([issue135Route({ currentPosition: at(-26.8, -65.18) })], { kind: "route", routeId: 7 });
    expect(first).toEqual({ center: [-65.18, -26.8], routeId: 7, highlightStopId: null, label: "Siguiendo al Recorrido #7" });
    applyFollowCenter(map, first!.center);
    const refreshed = followTarget([issue135Route({ currentPosition: at(-26.79, -65.17) })], { kind: "route", routeId: 7 });
    applyFollowCenter(map, refreshed!.center);
    expect(map.easeTo.mock.calls).toEqual([[{ center: [-65.18, -26.8] }], [{ center: [-65.17, -26.79] }]]);

    const withoutPosition = followTarget([issue135Route({ currentPosition: null })], { kind: "route", routeId: 7 });
    expect(withoutPosition).toEqual({ center: null, routeId: 7, highlightStopId: null, label: "Sin posición todavía" });
    applyFollowCenter(map, withoutPosition!.center);
    expect(map.easeTo).toHaveBeenCalledTimes(2);

    expect(followTarget([issue135Route()], null)).toBeNull();
    expect(followTarget([], { kind: "route", routeId: 7 })).toBeNull();
  });

  it("#140 Regla 2: moving the map by hand (drag or zoom) stops following, a programmatic move does not, and Seguir follows again", () => {
    const map = followMap();
    const onStop = vi.fn();
    const unbind = bindManualMoveStop(map, onStop);
    map.handlers.get("zoomstart")!({});
    map.handlers.get("dragstart")!({ type: "dragstart" });
    expect(onStop).not.toHaveBeenCalled();
    map.handlers.get("dragstart")!({ originalEvent: {} });
    map.handlers.get("zoomstart")!({ originalEvent: {} });
    expect(onStop).toHaveBeenCalledTimes(2);
    unbind();
    expect(map.handlers.size).toBe(0);
    expect(map.off).toHaveBeenCalledWith("dragstart", expect.any(Function));
    expect(map.off).toHaveBeenCalledWith("zoomstart", expect.any(Function));

    // Not following any more: the Seguir button is still there to follow again.
    const markup = renderPanel(issue135Route({ currentPosition: at(-26.8, -65.18) }));
    expect(markup).toContain('data-testid="follow-route-7"');
    expect(markup).not.toContain('data-testid="follow-label"');
  });

  it("#140 Regla 3: a Pasajero in Subió follows the Recorrido of that Traslado, labelled A bordo del Recorrido #N (Chofer X)", () => {
    const route = issue135Route({
      id: 8,
      driver: { id: 2, name: "Carla Sintética" },
      currentPosition: at(-26.81, -65.19),
      stops: [
        stop140({ id: 81, kind: "pickup", transferId: 5, status: "subio", completed: true, plannedTime: "07:40" }),
        stop140({ id: 82, kind: "dropoff", transferId: 5, status: "pending" }),
      ],
    });
    expect(followTarget([issue135Route(), route], { kind: "passenger", passengerId: 30 })).toEqual({
      center: [-65.19, -26.81],
      routeId: 8,
      highlightStopId: null,
      label: "A bordo del Recorrido #8 (Chofer Carla Sintética)",
    });
    // The followed Recorrido without a position: the map does not move, the Pasajero label stays.
    expect(followTarget([{ ...route, currentPosition: null }], { kind: "passenger", passengerId: 30 })).toEqual({
      center: null,
      routeId: 8,
      highlightStopId: null,
      label: "A bordo del Recorrido #8 (Chofer Carla Sintética)",
    });
  });

  it("#140 Regla 4: a planificado Pasajero follows the Recorrido that picks it up, highlights its pickup stop and says Lo busca el Recorrido #N, HH:MM planificada", () => {
    const route = issue135Route({
      currentPosition: at(-26.8, -65.18),
      stops: [
        stop140({ id: 71, kind: "pickup", transferId: 5, status: "pending", plannedTime: "07:40" }),
        stop140({ id: 72, kind: "dropoff", transferId: 5, status: "pending", plannedTime: "08:10" }),
      ],
    });
    const target = followTarget([route], { kind: "passenger", passengerId: 30 });
    expect(target).toEqual({ center: [-65.18, -26.8], routeId: 7, highlightStopId: 71, label: "Lo busca el Recorrido #7, 07:40 planificada" });

    const { map, library, createdMarkers } = createMockMap();
    updateMapRoutes(map, library, [route], 7, { current: [] }, { current: new Set<number>() }, undefined, target!.highlightStopId);
    const stops = createdMarkers.filter((m) => m.element?.className.startsWith("live-stop-marker"));
    expect(stops.map((m) => m.element?.className)).toEqual(["live-stop-marker live-stop-marker-highlighted", "live-stop-marker"]);
    expect(stops[0].element?.style.width).toBe("28px");
    expect(stops[1].element?.style.width).toBe("18px");
  });

  it("#140 Regla 5: an Entregado Pasajero follows no Recorrido, centers on the Entregado Marca when located and says Entregado a las HH:MM; without location only the label", () => {
    const delivered = (latitude: number | null, longitude: number | null) => [issue135Route({
      currentPosition: at(-26.8, -65.18),
      stops: [
        stop140({ id: 71, kind: "pickup", transferId: 5, status: "subio", completed: true }),
        stop140({ id: 72, kind: "dropoff", transferId: 5, status: "entregado", completed: true, delivered: { phoneTimeHhmi: "08:05", latitude, longitude } }),
      ],
    })];
    expect(followTarget(delivered(-26.82, -65.2), { kind: "passenger", passengerId: 30 })).toEqual({
      center: [-65.2, -26.82], routeId: null, highlightStopId: null, label: "Entregado a las 08:05",
    });
    expect(followTarget(delivered(null, null), { kind: "passenger", passengerId: 30 })).toEqual({
      center: null, routeId: null, highlightStopId: null, label: "Entregado a las 08:05",
    });
  });

  it("#140 Regla 6: an Ausente Pasajero is labelled Ausente and follows nobody", () => {
    const route = issue135Route({
      currentPosition: at(-26.8, -65.18),
      stops: [
        stop140({ id: 71, kind: "pickup", transferId: 5, status: "ausente", completed: true }),
        stop140({ id: 72, kind: "dropoff", transferId: 5, status: "ausente", completed: true }),
      ],
    });
    expect(followTarget([route], { kind: "passenger", passengerId: 30 })).toEqual({ center: null, routeId: null, highlightStopId: null, label: "Ausente" });
  });

  it("#140 Regla 7: with two Traslados the first not terminado by target time is used; if all are terminado, the last", () => {
    const salida = (status: string) => issue135Route({
      id: 8,
      currentPosition: at(-26.7, -65.1),
      stops: [
        stop140({ id: 81, kind: "pickup", transferId: 6, targetTime: "12:30", status, completed: status !== "pending", plannedTime: "12:10" }),
        stop140({ id: 82, kind: "dropoff", transferId: 6, targetTime: "12:30", status, completed: status !== "pending" }),
      ],
    });
    const entrada = issue135Route({
      currentPosition: at(-26.8, -65.18),
      stops: [
        stop140({ id: 71, kind: "pickup", transferId: 5, targetTime: "08:00", status: "subio", completed: true }),
        stop140({ id: 72, kind: "dropoff", transferId: 5, targetTime: "08:00", status: "entregado", completed: true, delivered: { phoneTimeHhmi: "07:55", latitude: null, longitude: null } }),
      ],
    });
    // The salida comes first in the response to show that the target time, not the order, decides.
    expect(followTarget([salida("pending"), entrada], { kind: "passenger", passengerId: 30 })).toEqual({
      center: [-65.1, -26.7], routeId: 8, highlightStopId: 81, label: "Lo busca el Recorrido #8, 12:10 planificada",
    });
    expect(followTarget([salida("ausente"), entrada], { kind: "passenger", passengerId: 30 })?.label).toBe("Ausente");
    expect(followTarget([entrada, salida("ausente")], { kind: "passenger", passengerId: 30 })?.label).toBe("Ausente");
  });

  it("#140 Regla 8: only Pasajeros with Traslados that day appear in the search, once each", () => {
    const routes = [
      issue135Route({ stops: [stop140({ id: 71, kind: "pickup" }), stop140({ id: 72, kind: "dropoff" })] }),
      issue135Route({ id: 8, stops: [stop140({ id: 81, passengerId: 31, passengerName: "Ana Sintética" })] }),
    ];
    expect(dayPassengers(routes)).toEqual([{ id: 31, name: "Ana Sintética" }, { id: 30, name: "José Sintético" }]);
    expect(dayPassengers([])).toEqual([]);
    expect(filterPassengers(dayPassengers(routes), "Bruno")).toEqual([]);
    expect(followTarget(routes, { kind: "passenger", passengerId: 99 })).toBeNull();
  });

  it("#140 Regla 9: the search matches the name ignoring case and accents", () => {
    const passengers = [{ id: 30, name: "José Sintético" }, { id: 31, name: "Ana Sintética" }];
    expect(filterPassengers(passengers, "jose")).toEqual([{ id: 30, name: "José Sintético" }]);
    expect(filterPassengers(passengers, "JOSÉ")).toEqual([{ id: 30, name: "José Sintético" }]);
    expect(filterPassengers(passengers, "  sintetic ")).toEqual(passengers);
    expect(filterPassengers(passengers, "")).toEqual([]);
  });

  it("#140 Criterio 1: every Recorrido has a Seguir button; while following, the label and Dejar de seguir are shown", () => {
    const plan = { date: "2026-10-23", timeZone: "America/Argentina/Tucuman", routes: [issue135Route({ currentPosition: at(-26.8, -65.18) }), issue135Route({ id: 8 })] };
    const markup = renderToStaticMarkup(<LiveMapPage initialData={plan} initialFollow={{ kind: "route", routeId: 7 }} />);
    expect(markup).toMatch(/<button[^>]*data-testid="follow-route-7"[^>]*>Seguir<\/button>/);
    expect(markup).toMatch(/<button[^>]*data-testid="follow-route-8"[^>]*>Seguir<\/button>/);
    expect(markup).toMatch(/data-testid="follow-label"[^>]*>Siguiendo al Recorrido #7<\/p>/);
    expect(markup).toContain(">Dejar de seguir</button>");
  });

  it("#140 Criterio 2: the Pasajero search lists the day's matches as buttons and the chosen Pasajero's state is labelled", () => {
    const route = issue135Route({ currentPosition: at(-26.8, -65.18), stops: [stop140({ id: 71, kind: "pickup", transferId: 5, plannedTime: "07:40" })] });
    const plan = { date: "2026-10-23", timeZone: "America/Argentina/Tucuman", routes: [route] };
    const markup = renderToStaticMarkup(<LiveMapPage initialData={plan} initialFollow={{ kind: "passenger", passengerId: 30 }} />);
    expect(markup).toContain("Buscar Pasajero");
    expect(markup).toMatch(/<input[^>]*type="search"/);
    expect(markup).toMatch(/data-testid="follow-label"[^>]*>Lo busca el Recorrido #7, 07:40 planificada<\/p>/);

    const search = renderToStaticMarkup(
      <PassengerSearch passengers={dayPassengers([route])} query="jose" onQuery={() => {}} onChoose={() => {}} />,
    );
    expect(search).toMatch(/<button[^>]*data-testid="passenger-30"[^>]*>José Sintético<\/button>/);
    expect(renderToStaticMarkup(
      <PassengerSearch passengers={dayPassengers([route])} query="zzz" onQuery={() => {}} onChoose={() => {}} />,
    )).toContain("Ningún Pasajero del día coincide");
  });

  it("#140 Criterio 3: the panel and the map stack on a phone instead of a fixed two-column grid, with tappable buttons", () => {
    const markup = renderPanel(issue135Route());
    expect(markup).not.toContain("grid-template-columns");
    expect(markup).toContain('data-testid="live-layout" style="display:flex;flex-wrap:wrap');
    expect(markup).toMatch(/data-testid="live-panel" style="flex:1 1 320px;min-width:0/);
    expect(markup).toMatch(/data-testid="live-map-container" style="flex:2 1 480px;min-width:0/);
    expect(markup).toMatch(/<button[^>]*data-testid="follow-route-7"[^>]*style="[^"]*min-height:44px/);
  });
});
