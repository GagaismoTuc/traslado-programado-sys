import { useCallback, useEffect, useRef, useState } from "react";
import {
  closeRoute, currentLocation, fetchHandover, HandoverView, newIncident, newMark, otherAdultReceiver, sendIncident, sendMark, startRoute, undoMark,
  type Handover, type IncidentKind, type Mark, type MarkKind, type Receiver,
} from "./Marks";
import {
  indexedDbStore, latestMarks, markQueue, refusedMarks, requestPersistentStorage, savedPlanFor, signOut, startFlushing, wipeIfRevoked, type CachedPlan,
  type QueuedItem, type QueuedMark, type SignOutOutcome,
} from "./offline";

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
  // A Trasbordo end: the Oficina records the handover there, so the app offers no Marca.
  trasbordo?: boolean;
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
  // From version 2 on: what changed since the version the Chofer acknowledged, or since the previous one.
  changes?: { sinceVersion: number; items: VersionChange[] };
};
export type VersionChange =
  | { kind: "vehicle"; from: string; to: string }
  | { kind: "added" | "removed"; transferId: number; passengerName: string }
  | { kind: "time"; transferId: number; stopKind: string; passengerName: string; from: string; to: string };
export type DriverDay = { date: string; routes: DriverRoute[] };

const PLAN_TIME_ZONE = "America/Argentina/Tucuman";

/** Today and tomorrow in the Plan diario's zone; the server refuses any other day whatever the app asks. */
export function driverDays(now = new Date()) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: PLAN_TIME_ZONE }).format(now);
  const tomorrow = new Date(`${today}T00:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return [today, tomorrow.toISOString().slice(0, 10)];
}

/** The days of a saved plan that are still today or tomorrow: a plan downloaded last evening opens as today's. */
export function visibleDays(days: DriverDay[], now = new Date()) {
  const dates = driverDays(now);
  return days.filter((day) => dates.includes(day.date));
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

function changeText(change: VersionChange) {
  if (change.kind === "vehicle") return `Vehicle: ${change.from} → ${change.to}`;
  if (change.kind === "time") {
    return `${change.stopKind === "pickup" ? "Pick up" : "Drop off"} ${change.passengerName}: ${change.from} → ${change.to}`;
  }
  return `${change.kind === "added" ? "New" : "Removed"}: ${change.passengerName}`;
}

/** What changed between versions, so the Chofer does not have to compare the lists. */
export function ChangesView({ route }: { route: DriverRoute }) {
  if (!route.changes?.items.length) return null;
  return <section>
    <p>{`Changes since version ${route.changes.sinceVersion}:`}</p>
    <ul>{route.changes.items.map((change, index) => <li key={index}>{changeText(change)}</li>)}</ul>
  </section>;
}

type Acknowledge = (routeId: number, version: number) => void;

/** A Traslado that keeps the Recorrido from closing, as the server lists it. */
export type OpenTransfer = { transferId: number; passengerName: string; direction: "entrada" | "salida"; status: "planificado" | "subio" };

const MARKED: Record<string, string> = { subio: "Subió", ausente: "Ausente", entregado: "Entregado", cancelado_ausencia: "Cancelled: absence" };

/** What the Chofer does on a Recorrido: start it, mark its Paradas, hand a Pasajero over at home and send the queue now. */
export type Marking = {
  sending: boolean;
  // The Marca in force for each Traslado, saved on the phone or confirmed by the server; never one the server refused.
  marks: Record<number, QueuedMark>;
  // The newest Marca the server refused for each Traslado, with its reason.
  refused: Record<number, QueuedMark>;
  // For each undo on the phone, by its UUID, the kind of the Marca it undoes.
  undone: Record<string, MarkKind>;
  // When the plan shown was requested, or null before any plan.
  planFetchedAt: string | null;
  // The open home drop-off with its downloaded data and the last refusal.
  handover: { transferId: number; data: Handover | null; blocked: string | null; searching: boolean } | null;
  // The Traslados the server named when it last refused to close a Recorrido.
  refusedClose: { routeId: number; transfers: OpenTransfer[] } | null;
  onStart: (route: DriverRoute) => void;
  onClose: (route: DriverRoute) => void;
  onMark: (route: DriverRoute, stop: DriverStop, kind: MarkKind, receiver?: Receiver) => void;
  onFlush: () => void;
  onUndo: (route: DriverRoute, mark: Mark) => void;
  onOpenHandover: (route: DriverRoute, stop: DriverStop) => void;
  onOtherAdult: (route: DriverRoute, stop: DriverStop, typed: { name: string; dni: string; adultConfirmed: boolean }) => void;
  onSearch: (route: DriverRoute, stop: DriverStop) => void;
  onIncident?: (route: DriverRoute, kind: IncidentKind, note: string) => void;
};

/**
 * The Traslado's state as the Chofer sees it: a Marca still on the phone, or one confirmed after the plan was requested,
 * wins over the plan, so a Marca made without signal is not offered again.
 */
export function stopStatus(stop: DriverStop, local: QueuedMark | undefined, planFetchedAt: string | null, undone: Record<string, MarkKind> = {}) {
  if (!local) return stop.transferStatus;
  if (local.state === "pending" || planFetchedAt === null || (local.confirmedAt ?? "") > planFetchedAt) return markState(local, undone) ?? stop.transferStatus;
  return stop.transferStatus;
}

// The Traslado's state before a Marca of each kind: an undo of that Marca returns it there.
const BEFORE: Record<string, string> = { subio: "planificado", ausente: "planificado", entregado: "subio" };

/** The state a Marca on the phone leaves the Traslado in, or undefined for an undo whose Marca the phone no longer holds. */
function markState(local: QueuedMark, undone: Record<string, MarkKind>) {
  if (local.mark.kind !== "undo") return local.mark.kind;
  const kind = undone[local.id];
  return kind ? BEFORE[kind] : undefined;
}

/** For each undo on the phone, by its UUID, the kind of the Marca it undoes. */
export function undoneKinds(items: QueuedItem[]) {
  const kinds: Record<string, MarkKind> = {};
  for (const item of items) {
    if (!("mark" in item)) continue;
    const target = item.mark.kind === "undo" ? items.find((other): other is QueuedMark => "mark" in other && other.id === item.mark.corrects) : undefined;
    if (target) kinds[item.id] = target.mark.kind;
  }
  return kinds;
}

/** Subió or Ausente at a pickup; Entregado at a drop-off once the Pasajero is on board, to the Destino or at home. */
export function StopActions({ route, stop, marking }: { route: DriverRoute; stop: DriverStop; marking: Marking }) {
  const local = marking.marks[stop.transferId];
  const refused = marking.refused[stop.transferId];
  const status = stopStatus(stop, local, marking.planFetchedAt, marking.undone);
  // The Marca's own state, unless the Oficina changed the Traslado since it was confirmed.
  const shown = local && (local.state === "pending" || status === markState(local, marking.undone)) ? local : null;
  // The Chofer may undo the Marca on the phone at its own Parada; an undo cannot be undone: the Chofer marks again instead.
  const undoable = shown && shown.mark.kind !== "undo" && stop.kind === (shown.mark.kind === "entregado" ? "dropoff" : "pickup") ? shown.mark : null;
  // The handover belongs to the drop-off, not to the pickup of the same Traslado.
  const open = stop.kind === "dropoff" && marking.handover?.transferId === stop.transferId ? marking.handover : null;
  const disabled = marking.sending;
  return <>
    {MARKED[status] && <div>{`Marked: ${MARKED[status]}`}</div>}
    {shown && <div>{shown.state === "pending" ? "Saved on phone" : "Confirmed by server"}</div>}
    {shown?.note && <p role="alert">{shown.note}</p>}
    {refused && <p role="alert">{`${MARKED[refused.mark.kind] ?? "Deshacer"} not saved by the server: ${refused.note}`}</p>}
    {(shown?.state === "pending" || refused) && <button type="button" onClick={marking.onFlush}>Send now</button>}
    {undoable && <button type="button" disabled={disabled} onClick={() => marking.onUndo(route, undoable)}>Deshacer</button>}
    {stop.trasbordo && status === (stop.kind === "pickup" ? "planificado" : "subio")
      && <p>Trasbordo: call the Oficina to record the handover</p>}
    {stop.kind === "pickup" && status === "planificado" && !stop.trasbordo && <div>
      <button type="button" disabled={disabled} onClick={() => marking.onMark(route, stop, "subio")}>Subió</button>
      <button type="button" disabled={disabled} onClick={() => marking.onMark(route, stop, "ausente")}>Ausente</button>
    </div>}
    {stop.kind === "dropoff" && status === "subio" && !stop.trasbordo && (stop.place.destinationId !== null
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

/**
 * The refused list with each Traslado's state as the Chofer sees it now (`stopStatus`, so a Marca saved on the phone counts),
 * without those resolved since; one no longer in the Recorrido (reassigned) is resolved.
 */
export function stillOpen(route: DriverRoute, transfers: OpenTransfer[], marking: Pick<Marking, "marks" | "planFetchedAt" | "undone">): OpenTransfer[] {
  return transfers.flatMap((transfer) => {
    const stop = route.stops.find((candidate) => candidate.transferId === transfer.transferId);
    const status = stop && stopStatus(stop, marking.marks[stop.transferId], marking.planFetchedAt, marking.undone);
    return status === "planificado" || status === "subio" ? [{ ...transfer, status }] : [];
  });
}

/** What the Chofer has to resolve before the Recorrido can close. */
export function CloseRefusal({ transfers }: { transfers: OpenTransfer[] }) {
  return <div role="alert">
    <p>Resolve these Traslados before closing the Recorrido:</p>
    <ul>{transfers.map((transfer) => <li key={transfer.transferId}>{transfer.status === "subio"
      ? `${transfer.passengerName}: on board, mark Entregado`
      : `${transfer.passengerName}: not marked, mark Subió or Ausente, or call the Oficina to reassign or cancel it`}</li>)}</ul>
  </div>;
}

export function IncidentForm({
  route,
  sending,
  onIncident,
}: {
  route: DriverRoute;
  sending: boolean;
  onIncident: (kind: IncidentKind, note: string) => void;
}) {
  return <details>
    <summary>Report incident</summary>
    <form
      aria-label="Report incident"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const kind = String(data.get("kind") ?? "delay") as IncidentKind;
        const note = String(data.get("note") ?? "").trim();
        if (!note) return;
        onIncident(kind, note);
        event.currentTarget.reset();
      }}
    >
      <h4>Report incident</h4>
      <label htmlFor={`incident-type-${route.routeId}`}>Type:</label>
      <select id={`incident-type-${route.routeId}`} name="kind" defaultValue="delay">
        <option value="delay">Delay</option>
        <option value="vehicle_fault">Vehicle fault</option>
        <option value="accident">Accident</option>
        <option value="health_crisis">Pasajero health crisis</option>
        <option value="other">Other</option>
      </select>
      <label htmlFor={`incident-note-${route.routeId}`}>Note:</label>
      <textarea id={`incident-note-${route.routeId}`} name="note" maxLength={2000} required />
      <small>No incluyas diagnósticos ni datos sensibles de salud.</small>
      <button type="submit" disabled={sending}>Submit incident</button>
    </form>
  </details>;
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
    <ChangesView route={route} />
    {marking && route.status === "publicado" && <button type="button" disabled={marking.sending} onClick={() => marking.onStart(route)}>Start Recorrido</button>}
    {marking && route.status === "en_curso" && <>
      <p>Recorrido en curso.</p>
      <button type="button" disabled={marking.sending} onClick={() => marking.onClose(route)}>Close Recorrido</button>
      {marking.refusedClose?.routeId === route.routeId && <CloseRefusal transfers={stillOpen(route, marking.refusedClose.transfers, marking)} />}
    </>}
    {marking && marking.onIncident && route.status === "en_curso" && (
      <IncidentForm route={route} sending={marking.sending} onIncident={(kind, note) => marking.onIncident!(route, kind, note)} />
    )}
    {marking && route.status === "cerrado" && <p>Recorrido closed.</p>}
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

/** Why "Cerrar sesión" left the session open. */
export function signOutRefusal(outcome: SignOutOutcome) {
  if (outcome.result !== "refused") return "Unable to reach the server: the session is still open";
  const marks = outcome.pending === 1 ? "1 Marca is" : `${outcome.pending} Marcas are`;
  return outcome.offline
    ? `No signal: ${marks} saved only on this phone. Cerrar sesión once the server confirms them.`
    : `${marks} not confirmed by the server yet. Cerrar sesión once the server confirms them.`;
}

/** The handover data of every home drop-off in the plan, so the handover rule works without signal; failures are skipped. */
async function downloadHandovers(apiUrl: string, days: DriverDay[]) {
  const handovers: Record<number, Handover> = {};
  await Promise.all(days.flatMap((day) => day.routes.flatMap((route) => route.stops
    .filter((stop) => stop.kind === "dropoff" && stop.place.destinationId === null)
    .map(async (stop) => {
      try {
        const response = await fetchHandover(apiUrl, route.routeId, stop.transferId);
        if (response.ok) handovers[stop.transferId] = await response.json() as Handover;
      } catch {
        // Kept from the previous download, if any.
      }
    }))));
  return handovers;
}

/**
 * Today's and tomorrow's Recorridos, fetched on open and on focus and saved on the phone, which shows the saved plan
 * without signal. Marcas go to the queue first and are sent on open, when the connection returns and when the app
 * becomes visible. A 401 sends the Chofer back to sign-in; a revoked device also wipes the phone. "Cerrar sesión" sends
 * the queue first and keeps the session open while a Marca is not confirmed.
 */
export function DriverHome({ apiUrl, userId, onSignedOut }: { apiUrl: string; userId: number; onSignedOut: () => void }) {
  const [plan, setPlan] = useState<CachedPlan | null>(null);
  const [message, setMessage] = useState("");
  // A failed load is shown until a later load succeeds, apart from the acknowledgement message.
  const [loadError, setLoadError] = useState("");
  const [sending, setSending] = useState(false);
  const [local, setLocal] = useState<QueuedItem[]>([]);
  const [handover, setHandover] = useState<Marking["handover"]>(null);
  const [refusedClose, setRefusedClose] = useState<Marking["refusedClose"]>(null);
  const [store] = useState(() => indexedDbStore());
  const [session] = useState(() => () => fetch(`${apiUrl}/auth/me`, { credentials: "include" }));
  const [queue] = useState(() => markQueue(
    store,
    (routeId, mark) => sendMark(apiUrl, routeId, mark),
    session,
    (routeId, incident) => sendIncident(apiUrl, routeId, incident),
  ));
  const latestLoad = useRef(0);
  const signedOut = useRef(onSignedOut);
  signedOut.current = onSignedOut;

  const refreshLocal = useCallback(async () => setLocal(await store.marks().catch(() => [])), [store]);

  const endSession = useCallback(async (response: Response) => {
    if (await wipeIfRevoked(response, store).catch(() => true)) {
      setPlan(null);
      setLocal([]);
    }
    signedOut.current();
  }, [store]);

  const load = useCallback(async () => {
    // Only the newest load may update the screen.
    const loadId = ++latestLoad.current;
    const requestedAt = new Date().toISOString();
    try {
      const responses = await Promise.all(driverDays().map((date) => fetch(`${apiUrl}/driver/days/${date}`, { credentials: "include" })));
      if (loadId !== latestLoad.current) return;
      const unauthorized = responses.find((response) => response.status === 401);
      if (unauthorized) return await endSession(unauthorized);
      if (responses.some((response) => !response.ok)) {
        setLoadError("Unable to load your Recorridos");
        return;
      }
      const days = await Promise.all(responses.map(async (response) => await response.json() as DriverDay));
      const fresh = await downloadHandovers(apiUrl, days);
      const previous = savedPlanFor(await store.plan().catch(() => null), userId);
      if (loadId !== latestLoad.current) return;
      const handovers: Record<number, Handover> = {};
      for (const route of days.flatMap((day) => day.routes)) {
        for (const stop of route.stops) {
          const data = fresh[stop.transferId] ?? previous?.handovers[stop.transferId];
          if (data) handovers[stop.transferId] = data;
        }
      }
      const next = { userId, days, handovers, fetchedAt: requestedAt };
      setPlan(next);
      setLoadError("");
      await store.putPlan(next).catch(() => undefined);
    } catch {
      if (loadId === latestLoad.current) setLoadError("Unable to reach the server");
    }
  }, [apiUrl, userId, store, endSession]);

  const flush = useCallback(async () => {
    const outcome = await queue.flush().catch(() => ({ result: "offline" as const, confirmed: 0 }));
    if (outcome.result === "revoked") {
      setPlan(null);
      setLocal([]);
      signedOut.current();
      return;
    }
    await refreshLocal();
    // An expired session keeps the queue: it is sent once the Chofer signs in again.
    if (outcome.result === "signed_out") return signedOut.current();
    if (outcome.confirmed) {
      setMessage(outcome.confirmed === 1 ? "Marca confirmed by the server" : `${outcome.confirmed} Marcas confirmed by the server`);
      await load();
    }
  }, [queue, refreshLocal, load]);

  useEffect(() => {
    // The saved plan shows until the first load answers.
    void store.plan().then((saved) => {
      const own = savedPlanFor(saved, userId);
      if (own) setPlan((current) => current ?? own);
    }).catch(() => undefined);
    void refreshLocal();
    void requestPersistentStorage(navigator.storage);
  }, [store, userId, refreshLocal]);
  useEffect(() => startRefetching(window, document, () => void load()), [load]);
  useEffect(() => startFlushing(window, document, () => void flush()), [flush]);

  async function closeSession() {
    setSending(true);
    try {
      const outcome = await signOut(store, queue, {
        session,
        logout: () => fetch(`${apiUrl}/auth/logout`, { method: "POST", credentials: "include" }),
      });
      if (outcome.result === "revoked") {
        setPlan(null);
        setLocal([]);
      } else {
        await refreshLocal();
      }
      if (outcome.result === "refused" || outcome.result === "unreachable") return setMessage(signOutRefusal(outcome));
      signedOut.current();
    } catch {
      setMessage("The phone could not check its Marcas: the session is still open");
    } finally {
      setSending(false);
    }
  }

  async function acknowledge(routeId: number, version: number) {
    setSending(true);
    try {
      const response = await acknowledgeVersion(apiUrl, routeId, version);
      if (response.status === 401) return await endSession(response);
      setMessage(response.ok ? `Version ${version} acknowledged` : "Unable to acknowledge the version");
      await load();
    } catch {
      setMessage("Unable to reach the server");
    } finally {
      setSending(false);
    }
  }

  async function downloadHandover(route: DriverRoute, stop: DriverStop, searching: boolean) {
    const saved = plan?.handovers[stop.transferId] ?? null;
    setHandover((current) => ({
      transferId: stop.transferId, data: (current?.transferId === stop.transferId ? current.data : null) ?? saved, blocked: null, searching,
    }));
    try {
      const response = await fetchHandover(apiUrl, route.routeId, stop.transferId);
      if (response.status === 401) return await endSession(response);
      const data = response.ok ? await response.json() as Handover : null;
      setHandover((current) => ({
        transferId: stop.transferId, data: data ?? current?.data ?? null, blocked: data ? null : "Unable to load who may receive", searching: false,
      }));
    } catch {
      // Without signal the saved plan still says who may receive; only "Buscar autorización" needs the server.
      setHandover((current) => {
        const data = current?.data ?? null;
        return { transferId: stop.transferId, data, blocked: data && !searching ? null : "Unable to reach the server", searching: false };
      });
    }
  }

  /** Saves a Marca on the phone, then sends the queue; an undo of a Marca goes the same way, so it also works without signal. */
  async function saveMark(route: DriverRoute, build: (location: Mark["location"], tappedAt: Date) => Mark, save = async (mark: Mark) => {
    await queue.add(route.routeId, mark);
    return "Marca saved on phone";
  }) {
    // The phone time is the tap, not when the GPS answers.
    const tappedAt = new Date();
    setSending(true);
    try {
      const location = await currentLocation(navigator.geolocation);
      const saved = await save(build(location, tappedAt));
      setHandover(null);
      setMessage(saved);
      await refreshLocal();
    } catch {
      setMessage("The phone could not save the Marca: mark it again");
      return;
    } finally {
      setSending(false);
    }
    await flush();
  }

  async function saveIncident(route: DriverRoute, kind: IncidentKind, note: string) {
    const tappedAt = new Date();
    setSending(true);
    try {
      const location = await currentLocation(navigator.geolocation);
      const incident = newIncident({ kind, note, location }, tappedAt);
      await queue.addIncident(route.routeId, incident);
      setMessage("Incidente saved on phone");
      await refreshLocal();
    } catch {
      setMessage("The phone could not save the Incidente: report it again");
      return;
    } finally {
      setSending(false);
    }
    await flush();
  }

  const marking: Marking = {
    sending,
    marks: latestMarks(local),
    refused: refusedMarks(local),
    undone: undoneKinds(local),
    planFetchedAt: plan?.fetchedAt ?? null,
    handover,
    refusedClose,
    onStart: (route) => void (async () => {
      setSending(true);
      try {
        const response = await startRoute(apiUrl, route.routeId);
        if (response.status === 401) return await endSession(response);
        setMessage(response.ok ? "Recorrido started" : "Unable to start the Recorrido");
        await load();
      } catch {
        setMessage("Unable to reach the server");
      } finally {
        setSending(false);
      }
    })(),
    onClose: (route) => void (async () => {
      setSending(true);
      try {
        const response = await closeRoute(apiUrl, route.routeId);
        if (response.status === 401) return await endSession(response);
        const result = await response.json().catch(() => null) as { transfers?: OpenTransfer[] } | null;
        setRefusedClose(response.status === 409 && result?.transfers ? { routeId: route.routeId, transfers: result.transfers } : null);
        setMessage(response.ok ? "Recorrido closed" : response.status === 409 && result?.transfers
          ? "The Recorrido cannot close yet: the Oficina was alerted" : "Unable to close the Recorrido");
        await load();
      } catch {
        setMessage("Unable to reach the server");
      } finally {
        setSending(false);
      }
    })(),
    onMark: (route, stop, kind, receiver) => void saveMark(route, (location, tappedAt) => newMark({
      transferId: stop.transferId, kind, location, version: route.version, ...(receiver ? { receiver } : {}),
    }, tappedAt)),
    onFlush: () => void flush(),
    // A Marca that never left the phone is cancelled there instead of undone on the server.
    onUndo: (route, mark) => void saveMark(route, (location, tappedAt) => undoMark(mark, route.version, location, tappedAt), async (undo) =>
      await queue.undo(route.routeId, undo) === "cancelled" ? "Marca removed from the phone: it is not sent" : "Marca saved on phone"),
    onOpenHandover: (route, stop) => void downloadHandover(route, stop, false),
    onOtherAdult: (route, stop, typed) => {
      if (!handover?.data) return;
      const result = otherAdultReceiver(handover.data, typed);
      if (result.ok) marking.onMark(route, stop, "entregado", result.receiver);
      else setHandover({ ...handover, blocked: result.message });
    },
    onSearch: (route, stop) => void downloadHandover(route, stop, true),
    onIncident: (route, kind, note) => void saveIncident(route, kind, note),
  };

  const [today] = driverDays();
  const days = plan ? visibleDays(plan.days) : null;
  return <>
    <button type="button" disabled={sending} onClick={() => void closeSession()}>Cerrar sesión</button>
    {loadError && <p role="alert">{loadError}</p>}
    {message && <p role="status">{message}</p>}
    {days
      ? days.length
        ? days.map((day) => <DayView
          key={day.date}
          title={day.date === today ? "Today" : "Tomorrow"}
          day={day}
          sending={sending}
          onAcknowledge={(routeId, version) => void acknowledge(routeId, version)}
          marking={marking}
        />)
        : <p>No plan saved on the phone for today.</p>
      : <p>Loading your Recorridos...</p>}
  </>;
}
