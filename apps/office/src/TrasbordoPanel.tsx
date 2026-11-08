import { useState, type FormEvent } from "react";
import { readError, redirectUnauthorized, send } from "./api";
import type { PassengerViolations } from "./PlanPage";

/** A Trasbordo leg's end at the point: leg A ends there (dropoff), leg B starts there (pickup). */
export type TrasbordoEnd = { stop: "pickup" | "dropoff"; lat: number; lng: number; time: string };
export type TrasbordoTransfer = {
  id: number;
  status: string;
  trasbordo?: TrasbordoEnd | null;
  chainedToTransferId?: number | null;
};
type RouteOption = { id: number; label: string };
type Refusal = { routeId: number; error: string; violations: PassengerViolations[] };
type Publication = { version?: { version: number }; error?: string; violations?: PassengerViolations[] };

/**
 * Which Trasbordo the Oficina can record on a Traslado: a planned one on a Planificado Traslado without one, a handover
 * of a Pasajero on board, also when their leg already started at a Trasbordo; otherwise none.
 */
export function trasbordoMode(transfer: TrasbordoTransfer): "planned" | "handover" | null {
  if (transfer.status === "planificado" && !transfer.trasbordo && !transfer.chainedToTransferId) return "planned";
  if (transfer.status === "subio") return "handover";
  return null;
}

/** The Marcas of a Trasbordo are recorded either way; the receiving Recorrido may still need publishing with a reason. */
export function trasbordoMessage(publication: Publication) {
  return publication.version
    ? `Trasbordo recorded. The receiving Recorrido is published as version ${publication.version.version}`
    : `Trasbordo recorded, but the receiving Recorrido was not published: ${publication.error}`;
}

/** The form of one Trasbordo; a planned handover may leave the place empty to use the planned point. */
export function TrasbordoForm({ transfer, mode, routes, onSubmit }: {
  transfer: TrasbordoTransfer;
  mode: "planned" | "handover";
  routes: RouteOption[];
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const options = routes.map((route) => <option key={route.id} value={route.id}>{route.label}</option>);
  const planned = transfer.trasbordo?.stop === "dropoff";
  return <form onSubmit={onSubmit}>
    {mode === "planned" ? <>
      <label>Trasbordo time<input type="time" name="time" required /></label>
      <label>Leg A (to the point) in<select name="fromRouteId" required>{options}</select></label>
      <label>Leg B (from the point) in<select name="toRouteId" required>{options}</select></label>
    </> : <label>Hand over to the Chofer of<select name="routeId" required>{options}</select></label>}
    <label>Trasbordo latitude<input type="number" name="lat" step="any" min={-90} max={90} required={!planned} defaultValue={planned ? transfer.trasbordo!.lat : ""} /></label>
    <label>Trasbordo longitude<input type="number" name="lng" step="any" min={-180} max={180} required={!planned} defaultValue={planned ? transfer.trasbordo!.lng : ""} /></label>
    {mode === "handover" && <label>Reason to publish the receiving Recorrido anyway<input name="overrideReason" maxLength={1000} /></label>}
    <button type="submit">{mode === "planned" ? "Plan Trasbordo" : "Record Trasbordo"}</button>
  </form>;
}

/**
 * The Trasbordo actions of one Traslado. A refused publication of the receiving Recorrido comes back as `refusal`, so it
 * shows under that Recorrido with its violations and the option to force it.
 */
export function TrasbordoPanel({ transfer, routes, onDone }: {
  transfer: TrasbordoTransfer;
  routes: RouteOption[];
  onDone: (message: string, refusal?: Refusal) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const mode = trasbordoMode(transfer);
  if (!mode) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const place = values.get("lat") && values.get("lng") ? { lat: Number(values.get("lat")), lng: Number(values.get("lng")) } : {};
    const routeId = Number(values.get(mode === "planned" ? "toRouteId" : "routeId"));
    const reason = String(values.get("overrideReason") ?? "").trim();
    const body = mode === "planned"
      ? { ...place, time: values.get("time"), fromRouteId: Number(values.get("fromRouteId")), toRouteId: routeId }
      : { routeId, ...place, ...(reason ? { overrideReason: reason } : {}) };
    try {
      const response = await send(`/transfers/${transfer.id}/${mode === "planned" ? "planned-trasbordo" : "trasbordo"}`, "POST", body);
      if (await redirectUnauthorized(response)) return;
      if (!response.ok) {
        await onDone(await readError(response, "Unable to record the Trasbordo"));
        return;
      }
      setOpen(false);
      if (mode === "planned") return await onDone("Trasbordo planned");
      const { publication } = await response.json() as { publication: Publication };
      await onDone(trasbordoMessage(publication), publication.violations
        ? { routeId, error: publication.error ?? "", violations: publication.violations }
        : undefined);
    } catch {
      await onDone("Unable to reach the server");
    }
  }

  return <>
    <button type="button" onClick={() => setOpen(!open)}>{mode === "planned" ? "Plan a Trasbordo" : "Trasbordo"}</button>
    {open && <TrasbordoForm transfer={transfer} mode={mode} routes={routes} onSubmit={(event) => void submit(event)} />}
  </>;
}
