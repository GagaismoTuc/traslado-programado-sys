import { useCallback, useEffect, useRef, useState } from "react";
import {
  currentLocation, fetchHandover, HandoverView, newMark, otherAdultReceiver, sendMark, startRoute,
  type Handover, type Mark, type MarkKind, type Receiver,
} from "./Marks";

export type DriverStop = {
  position: number;
  kind: "pickup" | "dropoff";
  plannedTime: string;
  transferId: number;
  direction: "entrada" | "salida";
  // The Traslado's state on the server: planificado, subio, ausente, entregado or cancelado_ausencia.
  transferStatus: string;
  // name and destinationId are the Destino, or null for the Pasajero's home.
  place: { name: string | null; destinationId: number | null; address: string; accessNotes: string | null };
  passenger: { name: string; wheelchair: boolean; medicalAlert: string | null };
  companions: number;
};
export type DriverRoute = {
  routeId: number;
  version: number;
  startTime: string;
  endTime: string;
  vehiclePlate: string;
  // borrador, publicado, en_curso or cerrado.
  status: string;
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

const MARKED: Record<string, string> = { subio: "Subió", ausente: "Ausente", entregado: "Entregado", cancelado_ausencia: "Cancelled: absence" };

/** What the Chofer does on a Recorrido: start it, mark its Paradas, hand a Pasajero over at home and resend a failed Marca. */
export type Marking = {
  sending: boolean;
  // Marcas that did not reach the server, by Traslado: sending them again repeats their UUID.
  unsent: Record<number, Mark>;
  // The open home drop-off with its downloaded data and the last refusal.
  handover: { transferId: number; data: Handover | null; blocked: string | null; searching: boolean } | null;
  onStart: (route: DriverRoute) => void;
  onMark: (route: DriverRoute, stop: DriverStop, kind: MarkKind, receiver?: Receiver) => void;
  onResend: (route: DriverRoute, mark: Mark) => void;
  onOpenHandover: (route: DriverRoute, stop: DriverStop) => void;
  onOtherAdult: (route: DriverRoute, stop: DriverStop, typed: { name: string; dni: string; adultConfirmed: boolean }) => void;
  onSearch: (route: DriverRoute, stop: DriverStop) => void;
};

/** Subió or Ausente at a pickup; Entregado at a drop-off once the Pasajero is on board, to the Destino or at home. */
export function StopActions({ route, stop, marking }: { route: DriverRoute; stop: DriverStop; marking: Marking }) {
  const unsent = marking.unsent[stop.transferId];
  const open = marking.handover?.transferId === stop.transferId ? marking.handover : null;
  const disabled = marking.sending;
  return <>
    {MARKED[stop.transferStatus] && <div>{`Marked: ${MARKED[stop.transferStatus]}`}</div>}
    {unsent && <p role="alert">
      {"The Marca did not reach the server. "}
      <button type="button" disabled={disabled} onClick={() => marking.onResend(route, unsent)}>Send again</button>
    </p>}
    {stop.kind === "pickup" && stop.transferStatus === "planificado" && <div>
      <button type="button" disabled={disabled} onClick={() => marking.onMark(route, stop, "subio")}>Subió</button>
      <button type="button" disabled={disabled} onClick={() => marking.onMark(route, stop, "ausente")}>Ausente</button>
    </div>}
    {stop.kind === "dropoff" && stop.transferStatus === "subio" && (stop.place.destinationId !== null
      ? <button type="button" disabled={disabled} onClick={() => marking.onMark(route, stop, "entregado", {
        kind: "destination", destinationId: stop.place.destinationId!,
      })}>{`Entregado at ${stop.place.name}`}</button>
      : !open && <button type="button" disabled={disabled} onClick={() => marking.onOpenHandover(route, stop)}>Entregado</button>)}
    {open && (open.data || open.blocked
      // Without the downloaded data (no signal) nobody but company staff at the base may receive: the app keeps blocking.
      ? <HandoverView handover={open.data ?? { transferId: stop.transferId, otherAdultAllowed: false, adults: [], authorizations: [], base: null }}
        blocked={open.blocked} searching={open.searching} actions={{
        onReceiver: (receiver) => marking.onMark(route, stop, "entregado", receiver),
        onOtherAdult: (typed) => marking.onOtherAdult(route, stop, typed),
        onSearch: () => marking.onSearch(route, stop),
      }} />
      : <p>Loading who may receive...</p>)}
  </>;
}

export function RouteView({ route, sending, onAcknowledge, marking }: {
  route: DriverRoute; sending: boolean; onAcknowledge: Acknowledge; marking?: Marking;
}) {
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
    {marking && route.status === "publicado" && <button type="button" disabled={marking.sending} onClick={() => marking.onStart(route)}>Start Recorrido</button>}
    {marking && route.status === "en_curso" && <p>Recorrido en curso.</p>}
    <ol>{route.stops.map((stop) => <li key={stop.position}>
      <StopView stop={stop} />
      {marking && <StopActions route={route} stop={stop} marking={marking} />}
    </li>)}</ol>
  </section>;
}

export function DayView({ title, day, sending, onAcknowledge, marking }: {
  title: string; day: DriverDay; sending: boolean; onAcknowledge: Acknowledge; marking?: Marking;
}) {
  return <section>
    <h2>{`${title} (${day.date})`}</h2>
    {day.routes.length
      ? day.routes.map((route) => <RouteView key={route.routeId} route={route} sending={sending} onAcknowledge={onAcknowledge} marking={marking} />)
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
  const [unsent, setUnsent] = useState<Record<number, Mark>>({});
  const [handover, setHandover] = useState<Marking["handover"]>(null);
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

  /** Sends a Marca; without signal it stays on screen with its UUID to be sent again. */
  async function submitMark(routeId: number, mark: Mark) {
    setSending(true);
    try {
      const response = await sendMark(apiUrl, routeId, mark);
      if (response.status === 401) {
        signedOut.current();
        return;
      }
      const result = await response.json().catch(() => null) as { error?: string; conflict?: boolean } | null;
      setUnsent(({ [mark.transferId]: _, ...rest }) => rest);
      if (!response.ok) setMessage(result?.error ?? "Unable to save the Marca");
      else setMessage(result?.conflict ? "The server already had this Marca with other content; it kept the first one" : "Marca confirmed by the server");
      if (response.ok) setHandover(null);
      await load();
    } catch {
      setUnsent((current) => ({ ...current, [mark.transferId]: mark }));
      setMessage("Unable to reach the server: send the Marca again");
    } finally {
      setSending(false);
    }
  }

  async function downloadHandover(route: DriverRoute, stop: DriverStop, searching: boolean) {
    setHandover((current) => ({ transferId: stop.transferId, data: current?.transferId === stop.transferId ? current.data : null, blocked: null, searching }));
    try {
      const response = await fetchHandover(apiUrl, route.routeId, stop.transferId);
      if (response.status === 401) {
        signedOut.current();
        return;
      }
      const data = response.ok ? await response.json() as Handover : null;
      setHandover((current) => ({
        transferId: stop.transferId, data: data ?? current?.data ?? null, blocked: data ? null : "Unable to load who may receive", searching: false,
      }));
    } catch {
      setHandover((current) => ({ transferId: stop.transferId, data: current?.data ?? null, blocked: "Unable to reach the server", searching: false }));
    }
  }

  const marking: Marking = {
    sending,
    unsent,
    handover,
    onStart: (route) => void (async () => {
      setSending(true);
      try {
        const response = await startRoute(apiUrl, route.routeId);
        if (response.status === 401) return signedOut.current();
        setMessage(response.ok ? "Recorrido started" : "Unable to start the Recorrido");
        await load();
      } catch {
        setMessage("Unable to reach the server");
      } finally {
        setSending(false);
      }
    })(),
    onMark: (route, stop, kind, receiver) => void (async () => {
      // The phone time is the tap, not when the GPS answers.
      const tappedAt = new Date();
      const location = await currentLocation(navigator.geolocation);
      await submitMark(route.routeId, newMark({ transferId: stop.transferId, kind, location, version: route.version, ...(receiver ? { receiver } : {}) }, tappedAt));
    })(),
    onResend: (route, mark) => void submitMark(route.routeId, mark),
    onOpenHandover: (route, stop) => void downloadHandover(route, stop, false),
    onOtherAdult: (route, stop, typed) => {
      if (!handover?.data) return;
      const result = otherAdultReceiver(handover.data, typed);
      if (result.ok) marking.onMark(route, stop, "entregado", result.receiver);
      else setHandover({ ...handover, blocked: result.message });
    },
    onSearch: (route, stop) => void downloadHandover(route, stop, true),
  };

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
        marking={marking}
      />)
      : <p>Loading your Recorridos...</p>}
  </>;
}
