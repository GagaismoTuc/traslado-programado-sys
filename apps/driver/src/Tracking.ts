// Foreground Seguimiento for the driver PWA: watches the Chofer's phone position while a Recorrido is en curso and the
// document is visible, samples at most once every 15 s (<= 100 m accuracy), and posts batches every 30 s with in-memory retry.
import type { DriverDay } from "./Days";

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

export type StartTrackingOptions = {
  routeId: number | null;
  doc: TrackingDocument;
  geolocation: TrackingGeolocation | undefined;
  send: (routeId: number, positions: PositionSample[]) => Promise<Response>;
  onStateChange: (state: TrackingState) => void;
  onUnauthorized?: (response: Response) => void;
  now?: () => number;
};

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
export function startTracking({
  routeId,
  doc,
  geolocation,
  send,
  onStateChange,
  onUnauthorized,
  now = () => Date.now(),
}: StartTrackingOptions): () => void {
  if (routeId === null) {
    onStateChange("idle");
    return () => undefined;
  }

  let stopped = false;
  let watchId: number | null = null;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let lastSampledAt: number | null = null;
  let flushing = false;
  let currentState: TrackingState = "idle";
  const buffer: PositionSample[] = [];

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

  function stopWatching() {
    if (watchId !== null) {
      const id = watchId;
      watchId = null;
      clearWatchSafe(id);
    }
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  async function flush() {
    if (stopped || flushing || buffer.length === 0) return;
    flushing = true;
    const batch = buffer.slice(0, MAX_BATCH_SIZE);
    try {
      const response = await send(routeId!, batch);
      if (response.ok) {
        // Remove only what was sent; readings captured while the request was in flight stay in buffer.
        buffer.splice(0, batch.length);
      } else if (response.status === 401) {
        stop();
        onUnauthorized?.(response);
      }
      // Other non-ok responses keep batch in memory for the next 30 s tick.
    } catch {
      // Network failure keeps batch in memory for the next 30 s tick.
    } finally {
      flushing = false;
    }
  }

  function onPosition(position: GeolocationPosition) {
    if (stopped) return;
    setState("active");
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
    if (accuracyMeters > MAX_ACCURACY_METERS) return;
    const timeMs = typeof position.timestamp === "number" && Number.isFinite(position.timestamp) && position.timestamp > 0
      ? position.timestamp
      : now();
    if (lastSampledAt !== null && timeMs - lastSampledAt < SAMPLE_INTERVAL_MS) return;
    lastSampledAt = timeMs;
    buffer.push({ lat, lng, accuracyMeters, phoneTime: new Date(timeMs).toISOString() });
  }

  function onError(error: Pick<GeolocationPositionError, "code">) {
    if (stopped) return;
    if (error?.code === 1) {
      stopWatching();
      setState("permission_denied");
    } else {
      setState("gps_unavailable");
    }
  }

  function startWatching() {
    if (stopped || doc.visibilityState !== "visible" || watchId !== null) return;
    if (!geolocation || typeof geolocation.watchPosition !== "function") {
      setState("permission_denied");
      return;
    }
    let deniedSynchronously = false;
    setState("active");
    try {
      const id = geolocation.watchPosition(
        onPosition,
        (error) => {
          if (error?.code === 1) deniedSynchronously = true;
          onError(error);
        },
        { enableHighAccuracy: true },
      );
      if (stopped || deniedSynchronously) {
        clearWatchSafe(id);
        return;
      }
      watchId = id;
      intervalId = setInterval(() => {
        void flush();
      }, FLUSH_INTERVAL_MS);
    } catch {
      watchId = null;
      setState("permission_denied");
    }
  }

  function onVisibilityChange() {
    if (stopped) return;
    if (doc.visibilityState === "visible") {
      startWatching();
    } else {
      stopWatching();
      setState("idle");
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    doc.removeEventListener("visibilitychange", onVisibilityChange);
    stopWatching();
    setState("idle");
  }

  doc.addEventListener("visibilitychange", onVisibilityChange);
  if (doc.visibilityState === "visible") {
    startWatching();
  } else {
    setState("idle", true);
  }
  return stop;
}
