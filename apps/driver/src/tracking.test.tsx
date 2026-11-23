import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DayView, DriverHome, RouteView, type DriverDay, type DriverRoute, type DriverStop, type Marking } from "./Days";
import { newMark } from "./Marks";
import { markQueue, type CachedPlan, type LocalStore, type QueuedMark } from "./offline";
import {
  activeTrackingRouteId,
  GPS_UNAVAILABLE_NOTICE,
  LOCATION_PERMISSION_NOTICE,
  sendPositions,
  startTracking,
  TRACKING_ACTIVE_TEXT,
  type PositionSample,
  type TrackingGeolocation,
  type TrackingState,
} from "./Tracking";

// Synthetic data only.
const stop: DriverStop = {
  position: 1,
  kind: "pickup",
  plannedTime: "08:00",
  transferId: 3,
  direction: "entrada",
  transferStatus: "planificado",
  place: { name: null, destinationId: null, address: "Calle Inventada 101", accessNotes: null },
  passenger: { name: "Pasajero Sintético", wheelchair: false, medicalAlert: null },
  companions: 0,
};

const sampleRoute = (status: string, routeId = 9): DriverRoute => ({
  routeId,
  version: 1,
  startTime: "07:00",
  endTime: "09:00",
  vehiclePlate: "AAA001",
  status,
  acknowledgedVersion: 1,
  stops: [stop],
});

const sampleMarking = (): Marking => ({
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
});

function fakeDoc(visibilityState: "visible" | "hidden" = "visible") {
  return Object.assign(new EventTarget(), { visibilityState });
}

function fakeGeolocation() {
  let nextId = 0;
  let onSuccess: PositionCallback | null = null;
  let onError: PositionErrorCallback | null = null;
  const watchOptions: (PositionOptions | undefined)[] = [];
  const cleared: number[] = [];
  const watchPosition = vi.fn((success: PositionCallback, error?: PositionErrorCallback | null, options?: PositionOptions) => {
    onSuccess = success;
    onError = error ?? null;
    watchOptions.push(options);
    return ++nextId;
  });
  const clearWatch = vi.fn((id: number) => {
    cleared.push(id);
  });
  const emit = (lat: number, lng: number, accuracy: number, timestamp: number) => {
    onSuccess?.({
      coords: { latitude: lat, longitude: lng, accuracy } as GeolocationCoordinates,
      timestamp,
    } as GeolocationPosition);
  };
  const fail = (code: number) => {
    onError?.({ code } as GeolocationPositionError);
  };
  return { geolocation: { watchPosition, clearWatch } as TrackingGeolocation, watchPosition, clearWatch, watchOptions, cleared, emit, fail };
}

function memoryStore(): LocalStore {
  const marks = new Map<string, QueuedMark>();
  let plan: CachedPlan | null = null;
  let epoch: string | null = null;
  return {
    marks: async () => [...marks.values()],
    putMark: async (item) => { marks.set(item.id, item); },
    deleteMark: async (id) => { marks.delete(id); },
    plan: async () => plan,
    putPlan: async (next) => { plan = next; },
    epoch: async () => epoch,
    putEpoch: async (next) => { epoch = next; },
    wipeEnded: async () => undefined,
    clear: async () => { marks.clear(); plan = null; epoch = null; },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-23T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Seguimiento in the driver app", () => {
  it("watches with high accuracy only while a Recorrido is en_curso and document is visible, calling clearWatch on hidden or close", () => {
    const doc = fakeDoc("visible");
    const geo = fakeGeolocation();
    const states: TrackingState[] = [];
    const send = vi.fn(async () => new Response(JSON.stringify({ saved: 0, ignored: 0 }), { status: 200 }));

    // No en_curso route → does not call watchPosition.
    expect(activeTrackingRouteId([{ date: "2026-10-23", routes: [sampleRoute("publicado"), sampleRoute("cerrado", 10)] }])).toBeNull();
    const stopIdle = startTracking({ routeId: null, doc, geolocation: geo.geolocation, send, onStateChange: (state) => states.push(state) });
    expect(geo.watchPosition).not.toHaveBeenCalled();
    stopIdle();

    // Active en_curso route while hidden → waits until visible.
    doc.visibilityState = "hidden";
    const activeDays: DriverDay[] = [{ date: "2026-10-23", routes: [sampleRoute("publicado", 8), sampleRoute("en_curso", 9)] }];
    expect(activeTrackingRouteId(activeDays)).toBe(9);
    const stop = startTracking({ routeId: 9, doc, geolocation: geo.geolocation, send, onStateChange: (state) => states.push(state) });
    expect(geo.watchPosition).not.toHaveBeenCalled();

    // Becomes visible → starts high-accuracy watchPosition.
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(geo.watchPosition).toHaveBeenCalledTimes(1);
    expect(geo.watchOptions[0]).toEqual({ enableHighAccuracy: true });
    expect(states.at(-1)).toBe("active");

    // Goes to background (hidden) → calls clearWatch(1).
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(geo.clearWatch).toHaveBeenCalledWith(1);
    expect(states.at(-1)).toBe("idle");

    // Returns to foreground → starts watchPosition again (id 2).
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(geo.watchPosition).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toBe("active");

    // Recorrido closes (cleanup runs) → calls clearWatch(2).
    stop();
    expect(geo.clearWatch).toHaveBeenCalledWith(2);
    expect(states.at(-1)).toBe("idle");
  });

  it("keeps at most one Posición every 15 s and discards readings with accuracy worse than 100 m", async () => {
    const doc = fakeDoc("visible");
    const geo = fakeGeolocation();
    const sent: PositionSample[][] = [];
    const send = vi.fn(async (_routeId: number, batch: PositionSample[]) => {
      sent.push(batch);
      return new Response(JSON.stringify({ saved: batch.length, ignored: 0 }), { status: 201 });
    });

    const stop = startTracking({ routeId: 9, doc, geolocation: geo.geolocation, send, onStateChange: () => undefined });
    const base = Date.parse("2026-10-23T12:00:00.000Z");

    // Inaccurate reading (> 100 m) is discarded and does not block an accurate reading right after.
    geo.emit(-26.83, -65.21, 150, base);
    // 4 valid readings within 10 s → only the first is kept.
    geo.emit(-26.831, -65.211, 100, base + 1000);
    geo.emit(-26.832, -65.212, 20, base + 4000);
    geo.emit(-26.833, -65.213, 15, base + 7000);
    geo.emit(-26.834, -65.214, 10, base + 10000);
    // 1 ms before the 15 s boundary → discarded; exact +15 s boundary (base + 16000) → accepted; accuracy 101 m → discarded.
    geo.emit(-26.8345, -65.2145, 10, base + 15999);
    geo.emit(-26.835, -65.215, 101, base + 16000);
    geo.emit(-26.836, -65.216, 12, base + 16000);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent).toEqual([[
      { lat: -26.831, lng: -65.211, accuracyMeters: 100, phoneTime: "2026-10-23T12:00:01.000Z" },
      { lat: -26.836, lng: -65.216, accuracyMeters: 12, phoneTime: "2026-10-23T12:00:16.000Z" },
    ]]);
    stop();
  });

  it("sends buffered Posiciones every 30 s and retains them in memory to retry on the next tick when sending fails", async () => {
    const doc = fakeDoc("visible");
    const geo = fakeGeolocation();
    let attempt = 0;
    const sent: PositionSample[][] = [];
    const send = vi.fn(async (_routeId: number, batch: PositionSample[]) => {
      attempt += 1;
      sent.push(batch);
      if (attempt === 1) throw new Error("offline");
      if (attempt === 2) return new Response(JSON.stringify({ error: "server error" }), { status: 500 });
      return new Response(JSON.stringify({ saved: batch.length, ignored: 0 }), { status: 201 });
    });

    const stop = startTracking({ routeId: 9, doc, geolocation: geo.geolocation, send, onStateChange: () => undefined });
    const base = Date.parse("2026-10-23T12:00:00.000Z");
    geo.emit(-26.83, -65.21, 15, base);

    // 30 s: network failure → retained in memory.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(1);

    // Add a second sample before the 60 s retry.
    geo.emit(-26.82, -65.2, 12, base + 35_000);
    // 60 s: HTTP 500 → both retained in memory.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toHaveLength(2);

    // 90 s: succeeds → both sent and cleared from memory.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent).toHaveLength(3);
    expect(sent[2]).toEqual([
      { lat: -26.83, lng: -65.21, accuracyMeters: 15, phoneTime: "2026-10-23T12:00:00.000Z" },
      { lat: -26.82, lng: -65.2, accuracyMeters: 12, phoneTime: "2026-10-23T12:00:35.000Z" },
    ]);

    // 120 s: buffer is now empty → no unnecessary request.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent).toHaveLength(3);
    stop();

    // A 401 resolving after stop() must not trigger onUnauthorized against an ended session.
    let resolveInFlight!: (response: Response) => void;
    const onUnauthorized = vi.fn();
    const slowSend = vi.fn(() => new Promise<Response>((resolve) => { resolveInFlight = resolve; }));
    const geoInFlight = fakeGeolocation();
    const stopInFlight = startTracking({
      routeId: 9, doc, geolocation: geoInFlight.geolocation, send: slowSend, onStateChange: () => undefined, onUnauthorized,
    });
    geoInFlight.emit(-26.83, -65.21, 10, base);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(slowSend).toHaveBeenCalledTimes(1);
    stopInFlight();
    resolveInFlight(new Response(null, { status: 401 }));
    await Promise.resolve();
    expect(onUnauthorized).not.toHaveBeenCalled();

    // Verify sendPositions posts to the expected driver endpoint with credentials.
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ saved: 1, ignored: 0 }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const payload: PositionSample[] = [{ lat: -26.83, lng: -65.21, accuracyMeters: 10, phoneTime: "2026-10-23T12:00:00.000Z" }];
    await sendPositions("https://api.example", 9, payload);
    expect(fetchMock).toHaveBeenCalledWith("https://api.example/driver/routes/9/positions", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ positions: payload }),
    });
  });

  it("shows location permission notice when permission is denied or geolocation is missing, and never blocks saving Marks", async () => {
    const doc = fakeDoc("visible");
    const states: TrackingState[] = [];
    const send = vi.fn(async () => { throw new Error("tracking broken"); });

    // Missing Geolocation → permission_denied state.
    const stopMissing = startTracking({ routeId: 9, doc, geolocation: undefined, send, onStateChange: (state) => states.push(state) });
    expect(states.at(-1)).toBe("permission_denied");
    stopMissing();

    // Permission denied (code 1) → permission_denied state and watch cleared.
    const geo = fakeGeolocation();
    const stopDenied = startTracking({ routeId: 9, doc, geolocation: geo.geolocation, send, onStateChange: (state) => states.push(state) });
    geo.fail(1);
    expect(states.at(-1)).toBe("permission_denied");
    expect(geo.clearWatch).toHaveBeenCalledWith(1);
    stopDenied();

    // GPS unavailable (code 2) → gps_unavailable state; malformed coordinates stay gps_unavailable, valid reading recovers to active.
    const geo2 = fakeGeolocation();
    const stopGps = startTracking({ routeId: 9, doc, geolocation: geo2.geolocation, send, onStateChange: (state) => states.push(state) });
    geo2.fail(2);
    expect(states.at(-1)).toBe("gps_unavailable");
    geo2.emit(Number.NaN, -65.21, 15, Date.parse("2026-10-23T12:00:00.000Z"));
    expect(states.at(-1)).toBe("gps_unavailable");
    geo2.emit(-26.83, -65.21, 15, Date.parse("2026-10-23T12:00:01.000Z"));
    expect(states.at(-1)).toBe("active");
    stopGps();

    // UI shows exact active and permission/GPS notices while leaving Subió, Ausente and Entregado enabled (not disabled).
    const dropoffStop: DriverStop = {
      position: 2,
      kind: "dropoff",
      plannedTime: "08:30",
      transferId: 4,
      direction: "entrada",
      transferStatus: "subio",
      place: { name: "Escuela Sintética", destinationId: 7, address: "Avenida Sintetica 303", accessNotes: null },
      passenger: { name: "Pasajero Sintético", wheelchair: false, medicalAlert: null },
      companions: 0,
    };
    const activeRoute: DriverRoute = { ...sampleRoute("en_curso"), stops: [stop, dropoffStop] };

    const activeHtml = renderToStaticMarkup(
      <RouteView route={activeRoute} sending={false} onAcknowledge={() => undefined} marking={sampleMarking()} tracking="active" />,
    );
    expect(activeHtml).toContain(`<p role="status">${TRACKING_ACTIVE_TEXT}</p>`);

    const deniedHtml = renderToStaticMarkup(
      <RouteView route={activeRoute} sending={false} onAcknowledge={() => undefined} marking={sampleMarking()} tracking="permission_denied" />,
    );
    expect(deniedHtml).toContain(`<p role="alert">${LOCATION_PERMISSION_NOTICE}</p>`);
    expect(deniedHtml).toContain('<button type="button">Subió</button>');
    expect(deniedHtml).toContain('<button type="button">Ausente</button>');
    expect(deniedHtml).toContain('<button type="button">Entregado at Escuela Sintética</button>');

    const gpsHtml = renderToStaticMarkup(
      <RouteView route={activeRoute} sending={false} onAcknowledge={() => undefined} marking={sampleMarking()} tracking="gps_unavailable" />,
    );
    expect(gpsHtml).toContain(`<p role="alert">${GPS_UNAVAILABLE_NOTICE}</p>`);
    expect(gpsHtml).toContain('<button type="button">Subió</button>');
    expect(gpsHtml).toContain('<button type="button">Ausente</button>');
    expect(gpsHtml).toContain('<button type="button">Entregado at Escuela Sintética</button>');

    // With tracking completely broken (throwing watchPosition + failing send), Subió, Ausente and Entregado all save and flush.
    const brokenGeo: TrackingGeolocation = {
      watchPosition: () => { throw new Error("geolocation crashed"); },
      clearWatch: () => { throw new Error("clearWatch crashed"); },
    };
    const stopBroken = startTracking({ routeId: 9, doc, geolocation: brokenGeo, send, onStateChange: (state) => states.push(state) });
    expect(states.at(-1)).toBe("permission_denied");

    const store = memoryStore();
    const sentKinds: string[] = [];
    const markSent = vi.fn(async (_routeId: number, mark: { id: string; kind: string }) => {
      sentKinds.push(mark.kind);
      return new Response(JSON.stringify({ mark: { id: mark.id, flags: [] } }), { status: 201 });
    });
    const session = vi.fn(async () => new Response(JSON.stringify({ serverEpoch: "e1" }), { status: 200 }));
    const queue = markQueue(store, markSent, session);
    const subio = newMark({ transferId: 3, kind: "subio", location: null, version: 1 }, new Date("2026-10-23T12:00:00.000Z"), "00000000-0000-4000-8000-000000000001");
    const ausente = newMark({ transferId: 4, kind: "ausente", location: null, version: 1 }, new Date("2026-10-23T12:00:01.000Z"), "00000000-0000-4000-8000-000000000002");
    const entregado = newMark(
      { transferId: 3, kind: "entregado", location: null, version: 1, receiver: { kind: "destination", destinationId: 7 } },
      new Date("2026-10-23T12:00:02.000Z"),
      "00000000-0000-4000-8000-000000000003",
    );
    await queue.add(9, subio);
    await queue.add(9, ausente);
    await queue.add(9, entregado);
    const outcome = await queue.flush();
    expect(outcome).toEqual({ result: "done", confirmed: 3 });
    expect(sentKinds).toEqual(["subio", "ausente", "entregado"]);
    stopBroken();
  });

  it("preserves RouteView and DayView rendering with and without tracking", () => {
    const day: DriverDay = {
      date: "2026-10-23",
      routes: [sampleRoute("publicado", 8), sampleRoute("en_curso", 9)],
    };
    const withoutTracking = renderToStaticMarkup(
      <DayView title="Today" day={day} sending={false} onAcknowledge={() => undefined} marking={sampleMarking()} />,
    );
    expect(withoutTracking).toContain("<h2>Today (2026-10-23)</h2>");
    expect(withoutTracking).not.toContain(TRACKING_ACTIVE_TEXT);
    expect(withoutTracking).not.toContain(LOCATION_PERMISSION_NOTICE);

    const withTracking = renderToStaticMarkup(
      <DayView title="Today" day={day} sending={false} onAcknowledge={() => undefined} marking={sampleMarking()} tracking={{ routeId: 9, state: "active" }} />,
    );
    expect(withTracking.match(new RegExp(TRACKING_ACTIVE_TEXT, "g"))).toHaveLength(1);
  });

  it("preserves DriverHome initial render with Seguimiento wired", () => {
    vi.stubGlobal("indexedDB", { open: vi.fn() });
    const html = renderToStaticMarkup(
      <DriverHome apiUrl="https://api.example" userId={1} onSignedOut={() => undefined} />,
    );
    expect(html).toContain("Cerrar sesión");
    expect(html).toContain("Loading your Recorridos...");
  });
});
