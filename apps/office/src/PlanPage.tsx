import { useEffect, useRef, useState, type FormEvent } from "react";
import { readError, redirectUnauthorized, send } from "./api";
import { OfficeNav } from "./OfficeNav";

type Transfer = {
  id: number;
  passengerName: string;
  direction: "entrada" | "salida";
  destinationName: string;
  originDestinationName: string | null;
  targetTime: string;
  companions: number;
  status: string;
  routeId: number | null;
};
type Stop = { id: number; kind: "pickup" | "dropoff"; passengerName: string; placeName: string | null };
type Route = {
  id: number;
  driverName: string;
  vehicleId: number;
  vehiclePlate: string;
  startTime: string;
  endTime: string;
  status: string;
  version: number | null;
  km: number | null;
  stops: Stop[];
};
type Day = {
  plan: { date: string; timeZone: string };
  transfers: Transfer[];
  unpublishedTransferIds: number[];
  routes: Route[];
  km: number | null;
};
export type PassengerViolations = {
  passengerId: number;
  passengerName: string;
  violations: { rule: string; transferId: number | null; message: string }[];
};
export type CascadeWarning = { routeId: number; version: number; fromRouteId: number; ok: boolean; problem: string | null };
/** An expired document of a Recorrido's Vehículo or Chofer, reported when assigning or publishing; it never blocks. */
export type DocumentWarning = { routeId: number; message: string };
type WarningsResult = { warnings?: DocumentWarning[]; warningsUnavailable?: boolean };
export type DaySummary = {
  published: { routeId: number; version: number }[];
  unchanged: number[];
  failed: { routeId: number; error: string; violations?: PassengerViolations[] }[];
  cascade: CascadeWarning[];
};
// A published Recorrido whose Chofer has not acknowledged its latest version; acknowledgedVersion is the last one seen.
export type MissingAcknowledgement = {
  routeId: number;
  version: number;
  driverName: string;
  startTime: string;
  endTime: string;
  acknowledgedVersion: number | null;
};
// A refused publication with the violations to show under its Recorrido; forcing is offered only when allowed.
type Refusal = { routeId: number; error: string; violations: PassengerViolations[] };
type Option = { id: number; name: string };
type PassengerOption = Option & { companions: number; deactivatedAt: string | null };
type DriverOption = Option & { usualVehicleId: number | null };
type VehicleOption = { id: number; plate: string; deactivatedAt: string | null };

const PLAN_TIME_ZONE = "America/Argentina/Tucuman";

// Planning screens are designed for phone width first: one column, full-width controls, nothing wider than the screen.
const PHONE_FIRST_CSS = `
.plan { box-sizing: border-box; max-width: 40rem; margin: 0 auto; padding: 0.5rem; overflow-wrap: anywhere; }
.plan *, .plan *::before, .plan *::after { box-sizing: border-box; }
.plan label { display: block; margin: 0.5rem 0; }
.plan input:not([type=checkbox]), .plan select, .plan button { display: block; width: 100%; min-height: 44px; font-size: 1rem; }
.plan ul { padding: 0; list-style: none; }
.plan li { border-bottom: 1px solid #ccc; padding: 0.5rem 0; }
.plan .stop-actions { display: flex; gap: 0.5rem; }
`;

export function todayInPlanZone(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: PLAN_TIME_ZONE }).format(now);
}

function kmLabel(km: number | null) {
  return km === null ? "km not computed yet" : `${km.toFixed(1)} km`;
}

function transferLabel(transfer: Transfer) {
  const from = transfer.direction === "entrada" ? transfer.originDestinationName ?? "home" : transfer.destinationName;
  const to = transfer.direction === "entrada" ? transfer.destinationName : "home";
  return `${transfer.targetTime} ${transfer.passengerName}: ${transfer.direction}, ${from} → ${to}`;
}

function stopLabel(stop: Stop) {
  return `${stop.kind === "pickup" ? "Pick up" : "Drop off"} ${stop.passengerName} at ${stop.placeName ?? "home"}`;
}

function routeName(routes: Pick<Route, "id" | "driverName" | "startTime" | "endTime">[], routeId: number) {
  const route = routes.find((item) => item.id === routeId);
  return route ? `${route.driverName} ${route.startTime}-${route.endTime}` : `Recorrido ${routeId}`;
}

/** A Recorrido may be forced with a reason unless it leaves a Traslado unserved. */
export function canForce(violations: PassengerViolations[]) {
  return violations.every((group) => group.violations.every((violation) => violation.rule !== "unserved_transfer"));
}

/** The validator's violations, grouped by Pasajero. */
export function ViolationList({ violations }: { violations: PassengerViolations[] }) {
  return <ul>{violations.map((group) => <li key={group.passengerId}>
    <strong>{group.passengerName}</strong>
    <ul>{group.violations.map((violation, index) => <li key={index}>{violation.message}</li>)}</ul>
  </li>)}</ul>;
}

type RouteNames = Pick<Route, "id" | "driverName" | "startTime" | "endTime">[];

/** The cascade warnings about a Chofer's chained next Recorrido. */
export function CascadeWarnings({ cascade, routes }: { cascade: CascadeWarning[]; routes: RouteNames }) {
  if (!cascade.length) return null;
  return <ul role="alert">{cascade.map((warning) => <li key={`${warning.fromRouteId}-${warning.routeId}`}>
    {warning.ok
      ? `Revalidated ${routeName(routes, warning.routeId)} (version ${warning.version}): the Chofer still reaches it in time.`
      : `Check ${routeName(routes, warning.routeId)} (version ${warning.version}): ${warning.problem}. It was not republished.`}
  </li>)}</ul>;
}

/** The expired documents of the saved Recorridos; unavailable when the API saved the change but could not read them. */
export function DocumentWarnings({ warnings, routes, unavailable = false }: { warnings: DocumentWarning[]; routes: RouteNames; unavailable?: boolean }) {
  if (unavailable) return <p role="alert">Saved, but expired documents could not be checked. Reload the plan to check them.</p>;
  if (!warnings.length) return null;
  return <ul role="alert">{warnings.map((warning, index) => <li key={index}>
    {`${routeName(routes, warning.routeId)}: ${warning.message}. It was not blocked.`}
  </li>)}</ul>;
}

/** What publishing the whole Plan diario did with each Recorrido. */
export function DaySummaryView({ summary, routes }: { summary: DaySummary; routes: RouteNames }) {
  return <section>
    <h3>Publication summary</h3>
    <p>{`Published: ${summary.published.length}. Unchanged: ${summary.unchanged.length}. Not published: ${summary.failed.length}.`}</p>
    <ul>{summary.published.map((item) => <li key={item.routeId}>{`${routeName(routes, item.routeId)}: version ${item.version}`}</li>)}</ul>
    {summary.failed.length > 0 && <>
      <h4>Not published</h4>
      <ul>{summary.failed.map((item) => <li key={item.routeId}>
        <strong>{routeName(routes, item.routeId)}</strong>: {item.error}
        {item.violations && <ViolationList violations={item.violations} />}
      </li>)}</ul>
    </>}
    <CascadeWarnings cascade={summary.cascade} routes={routes} />
  </section>;
}

/** Every Traslado of the day, not Cancelado por Ausencia, that no published Recorrido serves yet. */
export function UnpublishedTransfers({ day }: { day: Pick<Day, "transfers" | "unpublishedTransferIds"> }) {
  const unpublished = day.transfers.filter((transfer) => day.unpublishedTransferIds.includes(transfer.id));
  return <section>
    <h2>Without a published Recorrido</h2>
    {unpublished.length
      ? <ul>{unpublished.map((transfer) => <li key={transfer.id}>{transferLabel(transfer)}</li>)}</ul>
      : <p>Every Traslado has a published Recorrido.</p>}
  </section>;
}

/** The Choferes who have not acknowledged the latest Versión del plan of their Recorrido. */
export function MissingAcknowledgements({ missing }: { missing: MissingAcknowledgement[] }) {
  return <section>
    <h2>Not acknowledged by the Chofer</h2>
    {missing.length
      ? <ul>{missing.map((item) => <li key={item.routeId}>
        {`${item.driverName} ${item.startTime}-${item.endTime}: version ${item.version}, `
          + (item.acknowledgedVersion === null ? "no version acknowledged yet" : `last acknowledged version ${item.acknowledgedVersion}`)}
      </li>)}</ul>
      : <p>Every Chofer acknowledged the latest version of their Recorrido.</p>}
  </section>;
}

export function PlanPage() {
  const [date, setDate] = useState(todayInPlanZone);
  // The loaded view remembers its date, so a day is shown and mutable only while that date is selected.
  const [view, setView] = useState<{ date: string; day: Day | null; missing: boolean; unacknowledged: MissingAcknowledgement[] } | null>(null);
  const [passengers, setPassengers] = useState<PassengerOption[]>([]);
  const [destinations, setDestinations] = useState<Option[]>([]);
  const [drivers, setDrivers] = useState<DriverOption[]>([]);
  const [vehicles, setVehicles] = useState<VehicleOption[]>([]);
  const [direction, setDirection] = useState("entrada");
  const [companions, setCompanions] = useState("0");
  const [routeVehicle, setRouteVehicle] = useState("");
  const [message, setMessage] = useState("");
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [cascade, setCascade] = useState<CascadeWarning[]>([]);
  const [warnings, setWarnings] = useState<DocumentWarning[]>([]);
  const [warningsUnavailable, setWarningsUnavailable] = useState(false);
  const [summary, setSummary] = useState<DaySummary | null>(null);
  const [publishing, setPublishing] = useState(false);
  const selectedDate = useRef(date);
  selectedDate.current = date;
  const latestLoad = useRef(0);

  async function load(forDate: string) {
    // Only the newest load may update the screen; an older one that answers late is dropped.
    const loadId = ++latestLoad.current;
    const stale = () => loadId !== latestLoad.current || forDate !== selectedDate.current;
    try {
      const responses = await Promise.all([
        send(`/daily-plans/${forDate}`, "GET"),
        send(`/daily-plans/${forDate}/acknowledgements`, "GET"),
        send("/passengers", "GET"),
        send("/destinations", "GET"),
        send("/drivers", "GET"),
        send("/vehicles", "GET"),
      ]);
      if (stale()) return;
      if (await redirectUnauthorized(...responses)) return;
      const [dayRes, acknowledgementsRes, ...lists] = responses;
      if (lists.some((response) => !response.ok) || [dayRes, acknowledgementsRes].some((response) => !response.ok && response.status !== 404)) {
        if (!stale()) setMessage("Unable to load the plan");
        return;
      }
      const loadedDay = dayRes.ok ? await dayRes.json() as Day : null;
      const unacknowledged = acknowledgementsRes.ok
        ? (await acknowledgementsRes.json() as { missing: MissingAcknowledgement[] }).missing
        : [];
      const passengerList = (await lists[0].json() as { passengers: PassengerOption[] }).passengers;
      const destinationList = (await lists[1].json() as { destinations: Option[] }).destinations;
      const driverList = (await lists[2].json() as { drivers: DriverOption[] }).drivers;
      const vehicleList = (await lists[3].json() as { vehicles: VehicleOption[] }).vehicles;
      if (stale()) return;
      setView({ date: forDate, day: loadedDay, missing: dayRes.status === 404, unacknowledged });
      setPassengers(passengerList.filter((item) => !item.deactivatedAt));
      setDestinations(destinationList);
      setDrivers(driverList);
      setVehicles(vehicleList.filter((item) => !item.deactivatedAt));
    } catch {
      if (!stale()) setMessage("Unable to reach the server");
    }
  }

  useEffect(() => {
    // Publication results belong to the day they were made for.
    setRefusal(null);
    setCascade([]);
    setWarnings([]);
    setWarningsUnavailable(false);
    setSummary(null);
    void load(date);
  }, [date]);

  async function write(path: string, method: string, body: unknown, done: string) {
    try {
      const response = await send(path, method, body);
      if (await redirectUnauthorized(response)) return false;
      // Assigning a Vehículo or Chofer answers with the expired documents of the Recorrido, if any.
      const result = response.ok ? await response.clone().json().catch(() => null) as WarningsResult | null : null;
      setWarnings(result?.warnings ?? []);
      setWarningsUnavailable(result?.warningsUnavailable === true);
      setMessage(response.ok ? done : await readError(response, "Unable to save the plan"));
      if (response.ok) await load(selectedDate.current);
      return response.ok;
    } catch {
      setMessage("Unable to reach the server");
      return false;
    }
  }

  // A refusal with violations stays under its Recorrido so the planner can fix it or force it with a reason.
  // Each publication is a new version, so the buttons stay disabled while one is pending; an answer for another day is dropped.
  async function publishRoute(routeId: number, overrideReason?: string) {
    const forDate = selectedDate.current;
    setPublishing(true);
    try {
      const response = await send(`/routes/${routeId}/publish`, "POST", overrideReason === undefined ? {} : { overrideReason });
      if (await redirectUnauthorized(response)) return false;
      const result = await response.json().catch(() => null) as
        WarningsResult & { version?: { version: number }; cascade?: CascadeWarning[]; error?: string; violations?: PassengerViolations[] } | null;
      if (forDate !== selectedDate.current) return false;
      setSummary(null);
      if (response.ok && result?.version) {
        setRefusal(null);
        setCascade(result.cascade ?? []);
        setWarnings(result.warnings ?? []);
        setWarningsUnavailable(result.warningsUnavailable === true);
        setMessage(`Published as version ${result.version.version}`);
        await load(forDate);
        return true;
      }
      setCascade([]);
      setWarnings([]);
      setWarningsUnavailable(false);
      const error = result?.error ?? "Unable to publish the Recorrido";
      setRefusal(result?.violations ? { routeId, error, violations: result.violations } : null);
      setMessage(error);
    } catch {
      setMessage("Unable to reach the server");
    } finally {
      setPublishing(false);
    }
    return false;
  }

  async function publishDay() {
    const forDate = selectedDate.current;
    setPublishing(true);
    try {
      const response = await send(`/daily-plans/${forDate}/publish`, "POST");
      if (await redirectUnauthorized(response)) return;
      const result = response.ok ? await response.json() as DaySummary & WarningsResult : null;
      const error = result ? "" : await readError(response, "Unable to publish the plan");
      if (forDate !== selectedDate.current) return;
      if (!result) {
        setMessage(error);
        return;
      }
      setRefusal(null);
      setCascade([]);
      setWarnings(result.warnings ?? []);
      setWarningsUnavailable(result.warningsUnavailable === true);
      setSummary(result);
      setMessage("Plan diario published");
      await load(forDate);
    } catch {
      setMessage("Unable to reach the server");
    } finally {
      setPublishing(false);
    }
  }

  function submit(handler: (values: FormData) => Promise<boolean>) {
    return (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = event.currentTarget;
      void handler(new FormData(form)).then((ok) => { if (ok) form.reset(); });
    };
  }

  const addTransfer = submit((values) => write(`/daily-plans/${date}/transfers`, "POST", {
    passengerId: Number(values.get("passengerId")),
    direction,
    destinationId: Number(values.get("destinationId")),
    originDestinationId: direction === "entrada" && values.get("originDestinationId") ? Number(values.get("originDestinationId")) : null,
    targetTime: values.get("targetTime"),
    companions: Number(companions),
  }, "Traslado added"));

  const addRoute = submit((values) => write(`/daily-plans/${date}/routes`, "POST", {
    driverId: Number(values.get("driverId")),
    vehicleId: routeVehicle ? Number(routeVehicle) : null,
    startTime: values.get("startTime"),
    endTime: values.get("endTime"),
  }, "Recorrido created"));

  const giveDay = submit((values) => write(`/daily-plans/${date}/driver-days`, "POST", {
    driverId: Number(values.get("driverId")),
    transferIds: values.getAll("transferIds").map(Number),
  }, "Recorridos created for the Chofer's day"));

  const forceRoute = (routeId: number) => submit((values) => publishRoute(routeId, String(values.get("overrideReason") ?? "")));

  function chooseDriver(value: string) {
    const usual = drivers.find((item) => String(item.id) === value)?.usualVehicleId;
    setRouteVehicle(usual ? String(usual) : "");
  }

  function moveStop(route: Route, index: number, delta: number) {
    const ids = route.stops.map((stop) => stop.id);
    [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
    void write(`/routes/${route.id}/stops`, "PATCH", { stopIds: ids }, "Order saved");
  }

  const day = view?.date === date ? view.day : null;
  const missing = view?.date === date && view.missing;
  const routes = day?.routes ?? [];
  const unassigned = (day?.transfers ?? []).filter((item) => item.status === "planificado" && item.routeId === null);

  return <main className="plan">
    <style>{PHONE_FIRST_CSS}</style>
    <h1>Plan diario</h1>
    <OfficeNav />
    <label>Day<input type="date" name="date" value={date} required onChange={(e) => { if (e.target.value) setDate(e.target.value); }} /></label>
    {message && <p role="status">{message}</p>}
    <CascadeWarnings cascade={cascade} routes={view?.day?.routes ?? []} />
    <DocumentWarnings warnings={warnings} unavailable={warningsUnavailable} routes={view?.day?.routes ?? []} />
    {missing && <button type="button" onClick={() => void write("/daily-plans", "POST", { date }, "Plan diario created")}>Create plan</button>}
    {day && <>
      <p>Times are local to {day.plan.timeZone}. Day total: {kmLabel(day.km)}</p>
      <UnpublishedTransfers day={day} />
      <MissingAcknowledgements missing={view?.unacknowledged ?? []} />
      <h2>Traslados</h2>
      <ul>{day.transfers.map((transfer) => <li key={transfer.id}>
        <strong>{transferLabel(transfer)}</strong>
        <div>Companions: {transfer.companions}{transfer.status === "cancelado_ausencia" ? " - Cancelled: absence" : ""}</div>
        {transfer.status === "planificado" && <>
          <label>
            Recorrido
            <select
              value={transfer.routeId ?? ""}
              onChange={(e) => void write(`/transfers/${transfer.id}`, "PATCH", {
                routeId: e.target.value ? Number(e.target.value) : null,
              }, "Recorrido changed")}
            >
              <option value="">Unassigned</option>
              {routes.map((route) => <option key={route.id} value={route.id}>{`${route.driverName} ${route.startTime}-${route.endTime}`}</option>)}
            </select>
          </label>
          <button type="button" onClick={() => void write(`/transfers/${transfer.id}/absence`, "POST", {}, "Absence registered")}>Register absence</button>
        </>}
      </li>)}</ul>

      <form onSubmit={addTransfer}>
        <h2>New Traslado</h2>
        <label>
          Passenger
          <select name="passengerId" required defaultValue="" onChange={(e) => {
            setCompanions(String(passengers.find((item) => String(item.id) === e.target.value)?.companions ?? 0));
          }}>
            <option value="" disabled>Choose a passenger</option>
            {passengers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label>
          Direction
          <select name="direction" value={direction} onChange={(e) => setDirection(e.target.value)}>
            <option value="entrada">Entrada (arrives at the Destino)</option>
            <option value="salida">Salida (leaves the Destino for home)</option>
          </select>
        </label>
        {direction === "entrada" && <label>
          Starts at
          <select name="originDestinationId" defaultValue="">
            <option value="">Home</option>
            {destinations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>}
        <label>
          Destino
          <select name="destinationId" required defaultValue="">
            <option value="" disabled>Choose a Destino</option>
            {destinations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label>{direction === "entrada" ? "Arrival time" : "Pick-up time"}<input type="time" name="targetTime" required /></label>
        <label>
          Companions
          <select name="companions" value={companions} onChange={(e) => setCompanions(e.target.value)}>
            <option value="0">0</option>
            <option value="1">1</option>
            <option value="2">2</option>
          </select>
        </label>
        <button type="submit">Add Traslado</button>
      </form>

      <h2>Recorridos</h2>
      <ul>{routes.map((route) => <li key={route.id}>
        <strong>{`${route.driverName} ${route.startTime}-${route.endTime}`}</strong>
        <div>{route.status === "borrador" ? "Draft" : route.status}{route.version === null ? "" : ` - version ${route.version}`} - {kmLabel(route.km)}</div>
        <label>
          Vehicle
          <select
            value={route.vehicleId}
            onChange={(e) => void write(`/routes/${route.id}`, "PATCH", { vehicleId: Number(e.target.value) }, "Vehicle changed")}
          >
            {/* A Vehículo deactivated after it was chosen still shows until the Oficina changes it. */}
            {!vehicles.some((item) => item.id === route.vehicleId) && <option value={route.vehicleId}>{route.vehiclePlate}</option>}
            {vehicles.map((item) => <option key={item.id} value={item.id}>{item.plate}</option>)}
          </select>
        </label>
        <ol>{route.stops.map((stop, index) => <li key={stop.id}>
          {stopLabel(stop)}
          <div className="stop-actions">
            <button type="button" disabled={index === 0} onClick={() => moveStop(route, index, -1)}>Up</button>
            <button type="button" disabled={index === route.stops.length - 1} onClick={() => moveStop(route, index, 1)}>Down</button>
          </div>
        </li>)}</ol>
        <button type="button" disabled={publishing} onClick={() => void publishRoute(route.id)}>Publish</button>
        {refusal?.routeId === route.id && <div>
          <p>{refusal.error}</p>
          <ViolationList violations={refusal.violations} />
          {canForce(refusal.violations) && <form onSubmit={forceRoute(route.id)}>
            <label>Reason to publish anyway<input name="overrideReason" required maxLength={1000} /></label>
            <button type="submit" disabled={publishing}>Publish anyway</button>
          </form>}
        </div>}
      </li>)}</ul>
      <button type="button" disabled={publishing} onClick={() => void publishDay()}>Publish the whole plan</button>
      {summary && <DaySummaryView summary={summary} routes={routes} />}

      <form onSubmit={addRoute}>
        <h2>New Recorrido</h2>
        <label>
          Chofer
          <select name="driverId" required defaultValue="" onChange={(e) => chooseDriver(e.target.value)}>
            <option value="" disabled>Choose a Chofer</option>
            {drivers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label>
          Vehicle
          <select name="vehicleId" value={routeVehicle} onChange={(e) => setRouteVehicle(e.target.value)}>
            <option value="">Usual vehicle of the Chofer</option>
            {vehicles.map((item) => <option key={item.id} value={item.id}>{item.plate}</option>)}
          </select>
        </label>
        <label>From<input type="time" name="startTime" required /></label>
        <label>To<input type="time" name="endTime" required /></label>
        <button type="submit">Create Recorrido</button>
      </form>

      <form onSubmit={giveDay}>
        <h2>Give a Chofer their day</h2>
        <p>The day is cut into Recorridos wherever two consecutive target times are further apart than the configured gap (60 minutes by default).</p>
        <label>
          Chofer
          <select name="driverId" required defaultValue="">
            <option value="" disabled>Choose a Chofer</option>
            {drivers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <fieldset>
          <legend>Unassigned Traslados</legend>
          {unassigned.map((item) => <label key={item.id}><input type="checkbox" name="transferIds" value={item.id} />{transferLabel(item)}</label>)}
        </fieldset>
        <button type="submit">Create the Chofer's Recorridos</button>
      </form>
    </>}
  </main>;
}
