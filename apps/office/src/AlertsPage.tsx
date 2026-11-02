import { useEffect, useState } from "react";
import { redirectUnauthorized, send } from "./api";
import { OfficeNav } from "./OfficeNav";

type RemainingTransfer = {
  transferId: number;
  direction: "entrada" | "salida";
  targetTime: string;
  destinationName: string;
  originDestinationName: string | null;
};
export type Alert = {
  id: number;
  kind: string;
  createdAt: string;
  transferId: number | null;
  routeId: number | null;
  markId: string | null;
  passengerName: string | null;
  driverName: string | null;
  details: Record<string, unknown>;
};

// The inbox asks the server again every 15 seconds.
export const ALERT_POLL_MS = 15_000;

type Timers = { setInterval: (run: () => void, ms: number) => unknown; clearInterval: (handle: never) => void };

/** Loads now and every `intervalMs`; returns the cleanup that stops it. */
export function startPolling(load: () => void, intervalMs = ALERT_POLL_MS, timers: Timers = globalThis as unknown as Timers) {
  load();
  const handle = timers.setInterval(load, intervalMs);
  return () => timers.clearInterval(handle as never);
}

const REASONS: Record<string, string> = {
  transfer_moved: "the Traslado had been moved",
  consent_mismatch: "the Receptor does not match the Consentimiento",
  authorization_revoked: "the Autorización puntual had been revoked",
  route_closed: "the Recorrido was already closed",
  trasbordo_unlinked: "the Chofer marked it at a Trasbordo point: correct it and record the Trasbordo",
};

type OpenTransfer = { transferId: number; passengerName: string; status: "planificado" | "subio" };

function remainingLabel(transfer: RemainingTransfer) {
  const from = transfer.direction === "salida" ? transfer.destinationName : transfer.originDestinationName ?? "home";
  const to = transfer.direction === "salida" ? "home" : transfer.destinationName;
  return `${transfer.targetTime} ${transfer.direction}, ${from} → ${to}`;
}

/** One line per alert kind; the absence and refused-close alerts list the Traslados the Oficina has to decide about. */
export function AlertText({ alert }: { alert: Alert }) {
  const who = alert.passengerName ?? "A Pasajero";
  const by = alert.driverName ? ` (${alert.driverName})` : "";
  const details = alert.details;
  switch (alert.kind) {
    case "other_adult_handover":
      return <>{`${who} was handed to another adult, ${String(details.name)} (DNI ${String(details.dni)})${by}`}
        {details.authorized === true ? " - authorised by an Autorización puntual" : ""}</>;
    case "mark_flagged":
      return <>{`Marca accepted with a warning for ${who}${by}: ${(details.reasons as string[]).map((reason) => REASONS[reason] ?? reason).join(", ")}`}</>;
    case "mark_conflict":
      return <>{`The phone sent Marca ${alert.markId} again with different content for ${who}${by}: the first one is kept`}</>;
    case "authorization_conflict":
      return <>{`A revocation arrived after the Autorización puntual for ${String(details.name)} was used for ${who}: the Entregado stands`}</>;
    case "absent_on_entrada": {
      const remaining = details.remaining as RemainingTransfer[];
      return <>{`${who} was marked Ausente on an entrada${by}. `}
        {remaining.length
          ? <>Decide about the rest of the day:<ul>{remaining.map((transfer) => <li key={transfer.transferId}>{remainingLabel(transfer)}</li>)}</ul></>
          : "No other Traslados today."}</>;
    }
    case "close_refused": {
      const open = details.transfers as OpenTransfer[];
      return <>{`${alert.driverName ?? "A Chofer"} tried to close Recorrido ${String(alert.routeId)} with Traslados still open:`}
        <ul>{open.map((transfer) => <li key={transfer.transferId}>
          {`${transfer.passengerName}: ${transfer.status === "subio" ? "on board without Entregado" : "not marked"}`}
        </li>)}</ul></>;
    }
    default:
      return <>{alert.kind}</>;
  }
}

// Local time of the Plan diario's zone, as "HH:MM".
const CLOCK = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Argentina/Tucuman", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function AlertList({ alerts }: { alerts: Alert[] }) {
  if (!alerts.length) return <p>No alerts.</p>;
  return <ul>{alerts.map((alert) => <li key={alert.id}>
    <time dateTime={alert.createdAt}>{CLOCK.format(new Date(alert.createdAt))}</time>
    {" "}<AlertText alert={alert} />
  </li>)}</ul>;
}

/** The Oficina's alert inbox, newest first, refreshed every 15 seconds. */
export function AlertsPage() {
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => startPolling(() => void (async () => {
    try {
      const response = await send("/alerts", "GET");
      if (await redirectUnauthorized(response)) return;
      if (!response.ok) {
        setMessage("Unable to load the alerts");
        return;
      }
      setAlerts((await response.json() as { alerts: Alert[] }).alerts);
      setMessage("");
    } catch {
      setMessage("Unable to reach the server");
    }
  })()), []);

  return <main>
    <OfficeNav />
    <h1>Alerts</h1>
    {message && <p role="alert">{message}</p>}
    {alerts ? <AlertList alerts={alerts} /> : <p>Loading alerts...</p>}
  </main>;
}
