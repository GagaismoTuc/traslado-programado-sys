import { useCallback, useEffect, useRef, useState } from "react";

export type DriverStop = {
  position: number;
  kind: "pickup" | "dropoff";
  plannedTime: string;
  transferId: number;
  direction: "entrada" | "salida";
  // name is the Destino, or null for the Pasajero's home.
  place: { name: string | null; address: string; accessNotes: string | null };
  passenger: { name: string; wheelchair: boolean; medicalAlert: string | null };
  companions: number;
};
export type DriverRoute = {
  routeId: number;
  version: number;
  startTime: string;
  endTime: string;
  vehiclePlate: string;
  acknowledgedVersion: number | null;
  stops: DriverStop[];
};
export type DriverDay = { date: string; routes: DriverRoute[] };

const PLAN_TIME_ZONE = "America/Argentina/Tucuman";

/** Today and tomorrow in the Plan diario's zone; the server refuses any other day whatever the app asks. */
export function driverDays(now = new Date()) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: PLAN_TIME_ZONE }).format(now);
  const tomorrow = new Date(`${today}T00:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return [today, tomorrow.toISOString().slice(0, 10)];
}

type Listener = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/** Fetches now (the app was opened) and again whenever it gets focus or becomes visible; returns the cleanup. */
export function startRefetching(win: Listener, doc: Listener & { visibilityState: string }, refetch: () => void) {
  const onFocus = () => refetch();
  const onVisibility = () => {
    if (doc.visibilityState === "visible") refetch();
  };
  win.addEventListener("focus", onFocus);
  doc.addEventListener("visibilitychange", onVisibility);
  refetch();
  return () => {
    win.removeEventListener("focus", onFocus);
    doc.removeEventListener("visibilitychange", onVisibility);
  };
}

/** Sends the version the app is showing, which the server records even when a newer one exists. */
export async function acknowledgeVersion(apiUrl: string, routeId: number, version: number) {
  return await fetch(`${apiUrl}/driver/routes/${routeId}/acknowledgements`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version }),
  });
}

export function StopView({ stop }: { stop: DriverStop }) {
  return <>
    <strong>{`${stop.plannedTime} ${stop.kind === "pickup" ? "Pick up" : "Drop off"} ${stop.passenger.name}`}</strong>
    <div>{stop.place.name === null ? `Home: ${stop.place.address}` : `${stop.place.name}: ${stop.place.address}`}</div>
    {stop.place.accessNotes && <div>{`Access: ${stop.place.accessNotes}`}</div>}
    <div>{`Companions: ${stop.companions}`}</div>
    {stop.passenger.wheelchair && <div>Wheelchair</div>}
    {stop.passenger.medicalAlert && <div role="alert">{`Medical alert: ${stop.passenger.medicalAlert}`}</div>}
  </>;
}

type Acknowledge = (routeId: number, version: number) => void;

export function RouteView({ route, sending, onAcknowledge }: { route: DriverRoute; sending: boolean; onAcknowledge: Acknowledge }) {
  return <section>
    <h3>{`${route.startTime}-${route.endTime}, ${route.vehiclePlate}, version ${route.version}`}</h3>
    {route.acknowledgedVersion === route.version
      ? <p>{`You acknowledged version ${route.version}.`}</p>
      : <>
        {route.acknowledgedVersion !== null && <p role="alert">{`The plan changed since you acknowledged version ${route.acknowledgedVersion}.`}</p>}
        <button type="button" disabled={sending} onClick={() => onAcknowledge(route.routeId, route.version)}>
          {`Acknowledge version ${route.version}`}
        </button>
      </>}
    <ol>{route.stops.map((stop) => <li key={stop.position}><StopView stop={stop} /></li>)}</ol>
  </section>;
}

export function DayView({ title, day, sending, onAcknowledge }: { title: string; day: DriverDay; sending: boolean; onAcknowledge: Acknowledge }) {
  return <section>
    <h2>{`${title} (${day.date})`}</h2>
    {day.routes.length
      ? day.routes.map((route) => <RouteView key={route.routeId} route={route} sending={sending} onAcknowledge={onAcknowledge} />)
      : <p>No published Recorridos.</p>}
  </section>;
}

/** Today's and tomorrow's Recorridos, fetched on open and on focus; a 401 sends the Chofer back to sign-in. */
export function DriverHome({ apiUrl, onSignedOut }: { apiUrl: string; onSignedOut: () => void }) {
  const [days, setDays] = useState<DriverDay[] | null>(null);
  const [message, setMessage] = useState("");
  // A failed load is shown until a later load succeeds, apart from the acknowledgement message.
  const [loadError, setLoadError] = useState("");
  const [sending, setSending] = useState(false);
  const latestLoad = useRef(0);
  const signedOut = useRef(onSignedOut);
  signedOut.current = onSignedOut;

  const load = useCallback(async () => {
    // Only the newest load may update the screen.
    const loadId = ++latestLoad.current;
    try {
      const responses = await Promise.all(driverDays().map((date) => fetch(`${apiUrl}/driver/days/${date}`, { credentials: "include" })));
      if (loadId !== latestLoad.current) return;
      if (responses.some((response) => response.status === 401)) {
        signedOut.current();
        return;
      }
      if (responses.some((response) => !response.ok)) {
        setLoadError("Unable to load your Recorridos");
        return;
      }
      const loaded = await Promise.all(responses.map(async (response) => await response.json() as DriverDay));
      if (loadId !== latestLoad.current) return;
      setDays(loaded);
      setLoadError("");
    } catch {
      if (loadId === latestLoad.current) setLoadError("Unable to reach the server");
    }
  }, [apiUrl]);

  useEffect(() => startRefetching(window, document, () => void load()), [load]);

  async function acknowledge(routeId: number, version: number) {
    setSending(true);
    try {
      const response = await acknowledgeVersion(apiUrl, routeId, version);
      if (response.status === 401) {
        signedOut.current();
        return;
      }
      setMessage(response.ok ? `Version ${version} acknowledged` : "Unable to acknowledge the version");
      await load();
    } catch {
      setMessage("Unable to reach the server");
    } finally {
      setSending(false);
    }
  }

  return <>
    {loadError && <p role="alert">{loadError}</p>}
    {message && <p role="status">{message}</p>}
    {days
      ? days.map((day, index) => <DayView
        key={day.date}
        title={index === 0 ? "Today" : "Tomorrow"}
        day={day}
        sending={sending}
        onAcknowledge={(routeId, version) => void acknowledge(routeId, version)}
      />)
      : <p>Loading your Recorridos...</p>}
  </>;
}
