// Foreground Seguimiento for the driver PWA: watches the Chofer's phone position while a Recorrido is en curso and the
// document is visible, samples at most once every 15 s (<= 100 m accuracy), and posts batches every 30 s from the
// phone's queue of pending Posiciones, which keeps them through a lost signal or a reload.
import type { DriverDay } from "./Days";
import { overflowPositionIds, positionOrder, type PendingPosition, type PositionStore } from "./offline";

export const SAMPLE_INTERVAL_MS = 15_000;
export const FLUSH_INTERVAL_MS = 30_000;
export const MAX_ACCURACY_METERS = 100;
export const MAX_BATCH_SIZE = 100;

export const TRACKING_ACTIVE_TEXT = "Seguimiento activo";
export const LOCATION_PERMISSION_NOTICE = "Activá la ubicación para que la Oficina vea tu recorrido";
export const GPS_UNAVAILABLE_NOTICE = "Sin señal de GPS: no se puede obtener tu ubicación";

export type PositionSample = {
  lat: number;
  lng: number;
  accuracyMeters: number;
  phoneTime: string;
};

export type TrackingState = "idle" | "active" | "permission_denied" | "gps_unavailable";

export type TrackingGeolocation = Pick<Geolocation, "watchPosition" | "clearWatch">;
export type TrackingDocument = Pick<EventTarget, "addEventListener" | "removeEventListener"> & { visibilityState: string };

export type SendPositions = (routeId: number, positions: PositionSample[]) => Promise<Response>;

export type StartTrackingOptions = {
  routeId: number | null;
  doc: TrackingDocument;
  geolocation: TrackingGeolocation | undefined;
  onStateChange: (state: TrackingState) => void;
  onUnauthorized?: (response: Response) => void;
  now?: () => number;
} & (
  /** The phone's queue of pending Posiciones, shared with the flush that runs when the app opens or the signal returns. */
  | { queue: PositionQueue; send?: undefined }
  /** Without a queue, the Posiciones wait in memory only and go out through `send`. */
  | { send: SendPositions; queue?: undefined }
);

export type PositionFlushOutcome = { result: "done" | "offline" } | { result: "unauthorized"; response: Response };
export type PositionQueue = {
  add(routeId: number, sample: PositionSample): Promise<void>;
  flush(): Promise<PositionFlushOutcome>;
};

/** A `PositionStore` in memory, for a phone without IndexedDB; nothing in it survives a reload. */
export function memoryPositionStore(): PositionStore {
  let items: PendingPosition[] = [];
  return {
    positions: async () => [...items].sort(positionOrder),
    addPosition: async (position) => {
      items = [...items.filter((item) => item.id !== position.id), position];
      const dropped = new Set(overflowPositionIds(items));
      items = items.filter((item) => !dropped.has(item.id));
    },
    deletePositions: async (ids) => {
      const deleted = new Set(ids);
      items = items.filter((item) => !deleted.has(item.id));
    },
    clearPositions: async () => {
      items = [];
    },
  };
}

/**
 * The phone's queue of pending Posiciones. A round sends them in phone-time order, at most `MAX_BATCH_SIZE` per batch and
 * one Recorrido per batch. A 200 or 201 deletes the batch from the phone; a 400 or 409 also deletes it, since the server
 * will never take it, and logs the refusal without coordinates. No signal stops the round and keeps everything; a 5xx or
 * any other answer keeps that batch and skips the rest of its Recorrido until the next round. A 401 stops the round and
 * keeps everything, for the caller to end the session (a revoked device wipes the store). One round runs at a time.
 */
export function positionQueue(store: PositionStore, send: SendPositions): PositionQueue {
  let running: Promise<PositionFlushOutcome> | null = null;
  async function round(): Promise<PositionFlushOutcome> {
    const pending = await store.positions();
    const blocked = new Set<number>();
    const sentIds = new Set<string>();
    for (const first of pending) {
      if (sentIds.has(first.id) || blocked.has(first.routeId)) continue;
      const batch = pending.filter((item) => item.routeId === first.routeId && !sentIds.has(item.id)).slice(0, MAX_BATCH_SIZE);
      for (const item of batch) sentIds.add(item.id);
      const ids = batch.map((item) => item.id);
      let response: Response;
      try {
        response = await send(first.routeId, batch.map(({ lat, lng, accuracyMeters, phoneTime }) => ({ lat, lng, accuracyMeters, phoneTime })));
      } catch {
        return { result: "offline" };
      }
      if (response.status === 401) return { result: "unauthorized", response };
      if (response.status === 200 || response.status === 201) {
        await store.deletePositions(ids);
      } else if (response.status === 400 || response.status === 409) {
        await store.deletePositions(ids);
        console.warn(`Discarded ${ids.length} pending Posiciones of Recorrido ${first.routeId}: the server refused the batch with ${response.status}`);
      } else {
        blocked.add(first.routeId);
      }
    }
    return { result: "done" };
  }
  return {
    add: async (routeId, sample) => {
      await store.addPosition({ ...sample, id: `${routeId}|${sample.phoneTime}`, routeId });
    },
    flush: () => running ??= round().catch(() => ({ result: "offline" as const })).finally(() => {
      running = null;
    }),
  };
}

/** The Recorrido currently en curso in the visible days, or null when no Recorrido is active. */
export function activeTrackingRouteId(days: DriverDay[] | null | undefined): number | null {
  if (!days) return null;
  for (const day of days) {
    const active = day.routes.find((route) => route.status === "en_curso");
    if (active) return active.routeId;
  }
  return null;
}

/** Sends a batch of phone Posiciones for one Recorrido en curso. */
export async function sendPositions(apiUrl: string, routeId: number, positions: PositionSample[]) {
  return await fetch(`${apiUrl}/driver/routes/${routeId}/positions`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ positions }),
  });
}

/**
 * Watches the phone's position with high accuracy only while `routeId` is en curso and `doc` is visible.
 * Clears the watch whenever the document hides or the returned cleanup runs (route closed or unmount).
 * Never throws: any geolocation or network failure stays isolated from Marcas.
 */
export function startTracking(options: StartTrackingOptions): () => void {
  const { routeId, doc, geolocation, onStateChange, onUnauthorized, now = () => Date.now() } = options;
  if (routeId === null) {
    onStateChange("idle");
    return () => undefined;
  }
  const queue = options.queue ?? positionQueue(memoryPositionStore(), options.send);

  let stopped = false;
  let watchId: number | null = null;
  let watchToken = 0;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let lastSampledAt: number | null = null;
  let currentState: TrackingState = "idle";

  function setState(next: TrackingState, force = false) {
    if (!force && next === currentState) return;
    currentState = next;
    onStateChange(next);
  }

  function clearWatchSafe(id: number) {
    try {
      geolocation?.clearWatch(id);
    } catch {
      // Ignore broken clearWatch so cleanup never breaks the app.
    }
  }

  function stopWatch() {
    watchToken += 1;
    if (watchId !== null) {
      const id = watchId;
      watchId = null;
      clearWatchSafe(id);
    }
  }

  function startFlushing() {
    if (stopped || doc.visibilityState !== "visible" || intervalId !== null) return;
    intervalId = setInterval(() => {
      void flush();
    }, FLUSH_INTERVAL_MS);
  }

  function stopFlushing() {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  // Anything the queue keeps goes out on the next 30 s tick; readings captured while a batch is in flight stay queued.
  async function flush() {
    if (stopped) return;
    const outcome = await queue.flush();
    if (stopped || outcome.result !== "unauthorized") return;
    stop();
    onUnauthorized?.(outcome.response);
  }

  function onPosition(position: GeolocationPosition) {
    if (stopped) return;
    const lat = position.coords?.latitude;
    const lng = position.coords?.longitude;
    const accuracyMeters = position.coords?.accuracy;
    if (
      typeof lat !== "number" || !Number.isFinite(lat) || Math.abs(lat) > 90
      || typeof lng !== "number" || !Number.isFinite(lng) || Math.abs(lng) > 180
      || typeof accuracyMeters !== "number" || !Number.isFinite(accuracyMeters) || accuracyMeters < 0
    ) {
      return;
    }
    setState("active");
    if (accuracyMeters > MAX_ACCURACY_METERS) return;
    const timeMs = typeof position.timestamp === "number" && Number.isFinite(position.timestamp) && position.timestamp > 0
      ? position.timestamp
      : now();
    if (lastSampledAt !== null && timeMs - lastSampledAt < SAMPLE_INTERVAL_MS) return;
    lastSampledAt = timeMs;
    // A failed save loses only this reading; Seguimiento goes on.
    void queue.add(routeId!, { lat, lng, accuracyMeters, phoneTime: new Date(timeMs).toISOString() }).catch(() => undefined);
  }

  function onError(error: Pick<GeolocationPositionError, "code">) {
    if (stopped) return;
    if (error?.code === 1) {
      stopWatch();
      setState("permission_denied");
    } else {
      setState("gps_unavailable");
    }
  }

  function startWatch() {
    if (stopped || doc.visibilityState !== "visible" || watchId !== null) return;
    if (!geolocation || typeof geolocation.watchPosition !== "function") {
      setState("permission_denied");
      return;
    }
    const token = ++watchToken;
    let deniedSynchronously = false;
    setState("active");
    try {
      const id = geolocation.watchPosition(
        (position) => {
          if (token === watchToken) onPosition(position);
        },
        (error) => {
          if (token !== watchToken) return;
          if (error?.code === 1) deniedSynchronously = true;
          onError(error);
        },
        { enableHighAccuracy: true },
      );
      if (stopped || deniedSynchronously || token !== watchToken) {
        clearWatchSafe(id);
        return;
      }
      watchId = id;
    } catch {
      watchId = null;
      setState("permission_denied");
    }
  }

  function onVisibilityChange() {
    if (stopped) return;
    if (doc.visibilityState === "visible") {
      startFlushing();
      startWatch();
    } else {
      stopWatch();
      stopFlushing();
      setState("idle");
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    doc.removeEventListener("visibilitychange", onVisibilityChange);
    stopWatch();
    stopFlushing();
    setState("idle");
  }

  doc.addEventListener("visibilitychange", onVisibilityChange);
  if (doc.visibilityState === "visible") {
    startFlushing();
    startWatch();
  } else {
    setState("idle", true);
  }
  return stop;
}
