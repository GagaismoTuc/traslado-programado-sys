import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { LiveMapPage } from "./LiveMapPage";
import { createMarcaPopupContent, createStopPopupContent, updateMapRoutes } from "./LiveMap";
import liveMapSource from "./LiveMap.tsx?raw";
import secondFactorSource from "./SecondFactor.tsx?raw";

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
      lastMarca: {
        id: 5,
        kind: "subio",
        latitude: null,
        longitude: null,
        phoneTime: "2026-10-23T11:30:00.000Z",
        phoneTimeHhmi: "08:30",
      },
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
    const stop = { id: 1, position: 1, kind: "pickup" as const, passengerId: 1, passengerName: "Synthetic", placeName: "Synthetic", latitude: 0, longitude: 0, plannedTime: "08:55", eta: null, status: "pending", completed: false };
    const route = { id: 1, status: "planned", driver: { id: 1, name: "Synthetic" }, vehicle: { id: 1, plate: "TEST" }, color: "#000", childrenOnBoard: 0, lastMarca: null, stops: [stop], nextStop: { ...stop, eta: "08:55" }, geometry: [] as [number, number][] };
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
      lastMarca: {
        id: 99,
        kind: "subio",
        latitude: null,
        longitude: null,
        phoneTime: "2026-10-23T11:00:00Z",
        phoneTimeHhmi: "08:00",
      },
      stops: [
        {
          id: 1,
          position: 1,
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
      lastMarca: {
        id: 1,
        kind: "subio",
        latitude: -26.82,
        longitude: -65.20,
        phoneTime: "2026-10-23T11:00:00Z",
        phoneTimeHhmi: "08:00",
      },
      stops: [
        {
          id: 1,
          position: 1,
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
});
