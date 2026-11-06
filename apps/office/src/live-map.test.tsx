import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { LiveMapPage } from "./LiveMapPage";
import { createMarcaPopupContent, createStopPopupContent } from "./LiveMap";
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
        eta: "07:30",
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

    // Rule 2 assertion: next stop shows planned time marked as planificada and not a live ETA
    expect(markup).toContain('data-testid="route-eta-10"');
    expect(markup).toContain("07:30 (planificada)");

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
});
