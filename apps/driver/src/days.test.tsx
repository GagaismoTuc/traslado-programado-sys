import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acknowledgeVersion, driverDays, isIosDevice, isStandalonePwa, registerPushSubscription, RouteView, startRefetching, StopView, urlBase64ToUint8Array, visibleDays, type DriverRoute, type DriverStop } from "./Days";

// Synthetic data only.
const passenger = { name: "Pasajero Sintético", wheelchair: true, medicalAlert: "Alergia sintética a la penicilina" };
const pickup: DriverStop = {
  position: 1, kind: "pickup", plannedTime: "07:51", transferId: 3, direction: "entrada", transferStatus: "planificado",
  place: { name: null, destinationId: null, address: "Calle Inventada 101", accessNotes: "Timbre del fondo" }, passenger, companions: 1,
};
const dropoff: DriverStop = {
  position: 2, kind: "dropoff", plannedTime: "08:00", transferId: 3, direction: "entrada", transferStatus: "planificado",
  place: { name: "Escuela Sintética", destinationId: 4, address: "Avenida Sintetica 303", accessNotes: null },
  passenger: { name: "Pasajero Sintético", wheelchair: false, medicalAlert: null }, companions: 0,
};
const route = (version: number, acknowledgedVersion: number | null): DriverRoute => ({
  routeId: 9, version, startTime: "07:00", endTime: "09:00", vehiclePlate: "AAA001", status: "publicado", acknowledgedVersion, stops: [pickup],
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("driver Recorridos", () => {
  it("shows every Parada's address, access notes, Pasajero, Acompañantes, wheelchair and medical alert", () => {
    expect(renderToStaticMarkup(<StopView stop={pickup} />)).toBe(
      "<strong>07:51 Pick up Pasajero Sintético</strong><div>Home: Calle Inventada 101</div><div>Access: Timbre del fondo</div>"
      + "<div>Companions: 1</div><div>Wheelchair</div><div role=\"alert\">Medical alert: Alergia sintética a la penicilina</div>",
    );
    expect(renderToStaticMarkup(<StopView stop={dropoff} />)).toBe(
      "<strong>08:00 Drop off Pasajero Sintético</strong><div>Escuela Sintética: Avenida Sintetica 303</div><div>Companions: 0</div>",
    );
  });

  it("re-fetches when the app opens, gets focus or becomes visible", () => {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: "hidden" });
    const refetch = vi.fn();
    const stop = startRefetching(win, doc, refetch);
    expect(refetch).toHaveBeenCalledTimes(1);
    win.dispatchEvent(new Event("focus"));
    expect(refetch).toHaveBeenCalledTimes(2);
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(refetch).toHaveBeenCalledTimes(2);
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(refetch).toHaveBeenCalledTimes(3);
    stop();
    win.dispatchEvent(new Event("focus"));
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(refetch).toHaveBeenCalledTimes(3);
  });

  it("asks for today and tomorrow in the Plan diario's zone", () => {
    expect(driverDays(new Date("2026-10-23T12:00:00.000Z"))).toEqual(["2026-10-23", "2026-10-24"]);
    expect(driverDays(new Date("2026-10-24T02:30:00.000Z"))).toEqual(["2026-10-23", "2026-10-24"]);
  });

  it("opens the plan saved on the phone for today and tomorrow, so last evening's download is today's plan", () => {
    const day = (date: string) => ({ date, routes: [route(1, null)] });
    // Downloaded on the evening of the 22nd, opened at 06:30 of the 23rd without signal.
    expect(visibleDays([day("2026-10-22"), day("2026-10-23")], new Date("2026-10-23T09:30:00.000Z"))).toEqual([day("2026-10-23")]);
    expect(visibleDays([day("2026-10-23"), day("2026-10-24")], new Date("2026-10-23T09:30:00.000Z"))).toEqual([day("2026-10-23"), day("2026-10-24")]);
    expect(visibleDays([day("2026-10-21"), day("2026-10-22")], new Date("2026-10-23T09:30:00.000Z"))).toEqual([]);
  });
});

describe("Confirmación de versión in the driver app", () => {
  it("offers to acknowledge the version shown and says when it was already acknowledged", () => {
    expect(renderToStaticMarkup(<RouteView route={route(1, null)} sending={false} onAcknowledge={() => undefined} />))
      .toContain("<h3>07:00-09:00, AAA001, version 1</h3><button type=\"button\">Acknowledge version 1</button>");
    expect(renderToStaticMarkup(<RouteView route={route(2, 1)} sending={false} onAcknowledge={() => undefined} />))
      .toContain("<p role=\"alert\">The plan changed since you acknowledged version 1.</p><button type=\"button\">Acknowledge version 2</button>");
    expect(renderToStaticMarkup(<RouteView route={route(2, 2)} sending={false} onAcknowledge={() => undefined} />))
      .toContain("<p>You acknowledged version 2.</p><ol>");
  });

  it("shows what changed since the version the Chofer acknowledged", () => {
    const changed: DriverRoute = {
      ...route(2, 1),
      changes: {
        sinceVersion: 1,
        items: [
          { kind: "vehicle", from: "AAA001", to: "BBB002" },
          { kind: "added", transferId: 5, passengerName: "Pasajero Nuevo" },
          { kind: "removed", transferId: 6, passengerName: "Pasajero Ausente" },
          { kind: "time", transferId: 3, stopKind: "pickup", passengerName: "Pasajero Sintético", from: "07:51", to: "07:58" },
        ],
      },
    };
    expect(renderToStaticMarkup(<RouteView route={changed} sending={false} onAcknowledge={() => undefined} />)).toContain(
      "<section><p>Changes since version 1:</p><ul><li>Vehicle: AAA001 → BBB002</li><li>New: Pasajero Nuevo</li>"
      + "<li>Removed: Pasajero Ausente</li><li>Pick up Pasajero Sintético: 07:51 → 07:58</li></ul></section>",
    );
    expect(renderToStaticMarkup(<RouteView route={{ ...changed, changes: { sinceVersion: 1, items: [] } }} sending={false} onAcknowledge={() => undefined} />))
      .not.toContain("Changes since");
  });

  it("sends the version the Chofer saw, not the latest one", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await acknowledgeVersion("https://api.example", 9, 1);
    expect(fetchMock).toHaveBeenCalledWith("https://api.example/driver/routes/9/acknowledgements", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: 1 }),
    });
  });

  it("identifies iOS devices and standalone PWA mode", () => {
    expect(isIosDevice({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" } as any)).toBe(true);
    expect(isIosDevice({ userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)" } as any)).toBe(true);
    expect(isIosDevice({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel", maxTouchPoints: 5 } as any)).toBe(true);
    expect(isIosDevice({ userAgent: "Mozilla/5.0 (Linux; Android 14)", platform: "Linux armv8l", maxTouchPoints: 5 } as any)).toBe(false);
    expect(isIosDevice({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } as any)).toBe(false);

    expect(isStandalonePwa({ matchMedia: (query: string) => ({ matches: query === "(display-mode: standalone)" }) } as any)).toBe(true);
    expect(isStandalonePwa({ matchMedia: () => ({ matches: false }), navigator: { standalone: true } } as any)).toBe(true);
    expect(isStandalonePwa({ matchMedia: () => ({ matches: false }), navigator: { standalone: false } } as any)).toBe(false);
  });

  it("assigns route anchor id to RouteView", () => {
    const html = renderToStaticMarkup(<RouteView route={route(1, null)} sending={false} onAcknowledge={() => undefined} />);
    expect(html).toContain('id="route-9"');
    expect(html).toContain('data-testid="route-9"');
  });

  it("registers push subscription with public key and sends it to the server", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "https://api.example/push/public-key") {
        return new Response(JSON.stringify({ publicKey: "BP_test_public_key" }), { status: 200 });
      }
      if (url === "https://api.example/push/subscriptions") {
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    let subscribedKey: any = null;
    const mockPushManager = {
      getSubscription: async () => null,
      subscribe: async (opts: any) => {
        subscribedKey = opts.applicationServerKey;
        return {
          toJSON: () => ({
            endpoint: "https://push.example.com/sub/1",
            keys: { p256dh: "key-p256dh", auth: "key-auth" },
          }),
        };
      },
    };
    const mockNavigator = {
      serviceWorker: {
        ready: Promise.resolve({ pushManager: mockPushManager }),
      },
    };
    vi.stubGlobal("navigator", mockNavigator);
    vi.stubGlobal("PushManager", class {});
    vi.stubGlobal("Notification", { permission: "granted" });

    const registered = await registerPushSubscription("https://api.example");
    expect(registered).toBe(true);
    expect(subscribedKey).toBeInstanceOf(Uint8Array);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://api.example/push/public-key");
    expect(calls[1].url).toBe("https://api.example/push/subscriptions");
    expect(JSON.parse(calls[1].init?.body as string)).toEqual({
      endpoint: "https://push.example.com/sub/1",
      keys: { p256dh: "key-p256dh", auth: "key-auth" },
    });
  });
});
