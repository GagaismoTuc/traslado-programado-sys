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
type Stop = { id: number; kind: "pickup" | "dropoff"; passengerName: string; placeName: string | null; plannedTime: string | null };
type Route = {
  id: number;
  driverName: string;
  vehicleId: number;
  vehiclePlate: string;
  startTime: string;
  endTime: string;
  status: string;
  km: number | null;
  stops: Stop[];
  startKind: "home" | "previous" | "point" | null;
  startLat: number | null;
  startLng: number | null;
  endKind: "home" | "open" | null;
  frontSeat: boolean;
};
type OrderResult = {
  unassigned: { transferId: number; passengerName: string; reason: "capacity" | "time_window" | "adaptation" }[];
  violations: { message: string }[];
};
type Day = { plan: { date: string; timeZone: string }; transfers: Transfer[]; routes: Route[]; km: number | null };
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
  const label = `${stop.kind === "pickup" ? "Pick up" : "Drop off"} ${stop.passengerName} at ${stop.placeName ?? "home"}`;
  return stop.plannedTime ? `${stop.plannedTime} ${label}` : label;
}

const UNASSIGNED_REASONS = {
  capacity: "no room left in the Vehicle (seats or front seat)",
  time_window: "cannot make its time window",
  adaptation: "the Vehicle lacks a required feature",
};

function routeLabel(route: Route) {
  return `${route.driverName} ${route.startTime}-${route.endTime}${route.frontSeat ? " (front seat taken)" : ""}`;
}

export function PlanPage() {
  const [date, setDate] = useState(todayInPlanZone);
  // The loaded view remembers its date, so a day is shown and mutable only while that date is selected.
  const [view, setView] = useState<{ date: string; day: Day | null; missing: boolean } | null>(null);
  const [passengers, setPassengers] = useState<PassengerOption[]>([]);
  const [destinations, setDestinations] = useState<Option[]>([]);
  const [drivers, setDrivers] = useState<DriverOption[]>([]);
  const [vehicles, setVehicles] = useState<VehicleOption[]>([]);
  const [direction, setDirection] = useState("entrada");
  const [companions, setCompanions] = useState("0");
  const [routeVehicle, setRouteVehicle] = useState("");
  const [message, setMessage] = useState("");
  // The last "Order" answer per Recorrido, so what the engine could not place stays on screen.
  const [orders, setOrders] = useState<Record<number, OrderResult>>({});
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
        send("/passengers", "GET"),
        send("/destinations", "GET"),
        send("/drivers", "GET"),
        send("/vehicles", "GET"),
      ]);
      if (stale()) return;
      if (await redirectUnauthorized(...responses)) return;
      const [dayRes, ...lists] = responses;
      if (lists.some((response) => !response.ok) || (!dayRes.ok && dayRes.status !== 404)) {
        if (!stale()) setMessage("Unable to load the plan");
        return;
      }
      const loadedDay = dayRes.ok ? await dayRes.json() as Day : null;
      const passengerList = (await lists[0].json() as { passengers: PassengerOption[] }).passengers;
      const destinationList = (await lists[1].json() as { destinations: Option[] }).destinations;
      const driverList = (await lists[2].json() as { drivers: DriverOption[] }).drivers;
      const vehicleList = (await lists[3].json() as { vehicles: VehicleOption[] }).vehicles;
      if (stale()) return;
      setView({ date: forDate, day: loadedDay, missing: dayRes.status === 404 });
      setPassengers(passengerList.filter((item) => !item.deactivatedAt));
      setDestinations(destinationList);
      setDrivers(driverList);
      setVehicles(vehicleList.filter((item) => !item.deactivatedAt));
    } catch {
      if (!stale()) setMessage("Unable to reach the server");
    }
  }

  useEffect(() => { void load(date); }, [date]);

  async function write(path: string, method: string, body: unknown, done: string) {
    try {
      const response = await send(path, method, body);
      if (await redirectUnauthorized(response)) return false;
      setMessage(response.ok ? done : await readError(response, "Unable to save the plan"));
      if (response.ok) await load(selectedDate.current);
      return response.ok;
    } catch {
      setMessage("Unable to reach the server");
      return false;
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

  async function order(route: Route) {
    try {
      const response = await send(`/routes/${route.id}/order`, "POST");
      if (await redirectUnauthorized(response)) return;
      if (!response.ok) {
        setMessage(await readError(response, "Unable to order the Recorrido"));
        return;
      }
      const result = await response.json() as OrderResult;
      setOrders((current) => ({ ...current, [route.id]: result }));
      setMessage(result.unassigned.length ? "Order applied: some Traslados did not fit" : "Order applied");
      await load(selectedDate.current);
    } catch {
      setMessage("Unable to reach the server");
    }
  }

  const saveEnds = (route: Route) => submit(async (values) => {
    const startKind = values.get("startKind") || null;
    if (startKind === "point" && (!values.get("startLat") || !values.get("startLng"))) {
      setMessage("Give the latitude and longitude of the start point");
      return false;
    }
    return await write(`/routes/${route.id}`, "PATCH", {
      startKind,
      startLat: startKind === "point" ? Number(values.get("startLat")) : null,
      startLng: startKind === "point" ? Number(values.get("startLng")) : null,
      endKind: values.get("endKind") || null,
    }, "Start and end saved");
  });

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
    {missing && <button type="button" onClick={() => void write("/daily-plans", "POST", { date }, "Plan diario created")}>Create plan</button>}
    {day && <>
      <p>Times are local to {day.plan.timeZone}. Day total: {kmLabel(day.km)}</p>
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
              {routes.map((route) => <option key={route.id} value={route.id}>{routeLabel(route)}</option>)}
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
        <div>{route.status === "borrador" ? "Draft" : route.status} - {kmLabel(route.km)}</div>
        {route.frontSeat && <p>Carries a Pasajero who needs the front seat: check it when changing the Chofer or the Vehicle.</p>}
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
        {route.status === "borrador" && <button type="button" onClick={() => void order(route)}>Order</button>}
        {orders[route.id]?.unassigned.length ? <>
          <p>Not placed by the engine (back among the unassigned Traslados):</p>
          <ul>{orders[route.id].unassigned.map((item) => <li key={item.transferId}>
            {`${item.passengerName}: ${UNASSIGNED_REASONS[item.reason]}`}
          </li>)}</ul>
        </> : null}
        {orders[route.id]?.violations.length ? <ul>{orders[route.id].violations.map((violation, index) => <li key={index}>
          {violation.message}
        </li>)}</ul> : null}
        <form key={`${route.startKind}-${route.startLat}-${route.startLng}-${route.endKind}`} onSubmit={saveEnds(route)}>
          <label>
            Starts at
            <select name="startKind" defaultValue={route.startKind ?? ""}>
              <option value="">Default (home, or where the previous Recorrido ended)</option>
              <option value="home">The Chofer's home</option>
              <option value="previous">Where the previous Recorrido ended</option>
              <option value="point">A given point</option>
            </select>
          </label>
          <label>Start latitude<input type="number" name="startLat" step="any" min={-90} max={90} defaultValue={route.startLat ?? ""} /></label>
          <label>Start longitude<input type="number" name="startLng" step="any" min={-180} max={180} defaultValue={route.startLng ?? ""} /></label>
          <label>
            Ends at
            <select name="endKind" defaultValue={route.endKind ?? ""}>
              <option value="">Default (home after the day's last Recorrido, else open)</option>
              <option value="home">The Chofer's home</option>
              <option value="open">Open</option>
            </select>
          </label>
          <button type="submit">Save start and end</button>
        </form>
        <ol>{route.stops.map((stop, index) => <li key={stop.id}>
          {stopLabel(stop)}
          <div className="stop-actions">
            <button type="button" disabled={index === 0} onClick={() => moveStop(route, index, -1)}>Up</button>
            <button type="button" disabled={index === route.stops.length - 1} onClick={() => moveStop(route, index, 1)}>Down</button>
          </div>
        </li>)}</ol>
      </li>)}</ul>

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
