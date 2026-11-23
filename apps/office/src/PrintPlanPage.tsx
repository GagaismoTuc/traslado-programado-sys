import { useEffect, useState } from "react";
import { readError, redirectUnauthorized, send } from "./api";
import { OfficeNav } from "./OfficeNav";
import { todayInPlanZone } from "./PlanPage";

export type PrintStop = {
  position: number;
  kind: "pickup" | "dropoff";
  plannedTime: string;
  transferId: number;
  direction: string;
  passengerName: string;
  companions: number;
  wheelchair: boolean;
  medicalAlert: string | null;
  accessNotes: string | null;
  passengerAccessNotes?: string | null;
  placeAccessNotes?: string | null;
  destinationName: string;
  placeName: string;
  address: string;
};

export type PrintRoute = {
  routeId: number;
  version: number;
  publishedAt: string;
  startTime: string;
  endTime: string;
  driver: {
    id: number;
    name: string;
  };
  vehicle: {
    id: number;
    plate: string;
    model: string;
  };
  stops: PrintStop[];
};

export type UnpublishedTransfer = {
  id: number;
  passengerName: string;
  direction: string;
  destinationName: string;
  targetTime?: string;
  label?: string;
};

export type PrintPlanData = {
  plan: {
    date: string;
    timeZone: string;
  };
  routes: PrintRoute[];
};

export function formatPublicationTime(iso: string, timeZone = "America/Argentina/Tucuman") {
  try {
    return new Intl.DateTimeFormat("es-AR", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** Rendered when some Traslados of the day have no published Recorrido. */
export function PrintRefusal({ error, unpublishedTransfers }: { error: string; unpublishedTransfers: UnpublishedTransfer[] }) {
  return (
    <section role="alert" data-testid="print-refusal" className="print-refusal">
      <h2>Print or export refused</h2>
      <p>{error}</p>
      <ul>
        {unpublishedTransfers.map((item) => (
          <li key={item.id}>
            {item.label ?? `${item.targetTime ? item.targetTime + " " : ""}${item.passengerName}: ${item.direction} → ${item.destinationName}`}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Printable sheet for a single published Recorrido. */
export function PrintRouteSheet({ route, date, timeZone }: { route: PrintRoute; date: string; timeZone: string }) {
  return (
    <section className="print-route-page" data-testid={`print-route-${route.routeId}`}>
      <header className="print-route-header">
        <h1>Plan diario — {date}</h1>
        <div className="route-meta">
          <p><strong>Recorrido:</strong> {route.startTime} – {route.endTime}</p>
          <p><strong>Chofer:</strong> {route.driver.name}</p>
          <p><strong>Vehículo:</strong> {route.vehicle.plate} ({route.vehicle.model})</p>
          <p><strong>Versión:</strong> {route.version} (Publicado: {formatPublicationTime(route.publishedAt, timeZone)})</p>
        </div>
      </header>
      <table className="print-stops-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Hora</th>
            <th>Tipo</th>
            <th>Pasajero</th>
            <th>Acompañante</th>
            <th>Silla de ruedas</th>
            <th>Alerta médica</th>
            <th>Destino</th>
            <th>Lugar / Dirección</th>
            <th>Notas de acceso</th>
          </tr>
        </thead>
        <tbody>
          {route.stops.map((stop) => (
            <tr key={`${stop.transferId}-${stop.position}`}>
              <td>{stop.position}</td>
              <td>{stop.plannedTime}</td>
              <td>{stop.kind === "pickup" ? "Subida" : "Bajada"}</td>
              <td><strong>{stop.passengerName}</strong></td>
              <td>{stop.companions > 0 ? String(stop.companions) : "—"}</td>
              <td>{stop.wheelchair ? "Sí" : "No"}</td>
              <td>{stop.medicalAlert ?? "—"}</td>
              <td>{stop.destinationName}</td>
              <td>{stop.placeName !== "Domicilio" && stop.placeName !== stop.destinationName ? `${stop.placeName} (${stop.address})` : stop.address}</td>
              <td>{stop.accessNotes ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** Full printable view for the entire day. */
export function PrintPlanView({ plan, routes, onPrint }: { plan: { date: string; timeZone: string }; routes: PrintRoute[]; onPrint?: () => void }) {
  return (
    <div className="print-plan-container">
      <div className="no-print print-toolbar">
        <button type="button" onClick={onPrint ?? (() => window.print())}>Export to PDF / Print</button>
        <a href={`/plan?date=${plan.date}`}>Back to Plan diario</a>
      </div>
      {routes.length === 0 ? (
        <p>No published Recorridos for this day.</p>
      ) : (
        routes.map((route) => (
          <PrintRouteSheet key={route.routeId} route={route} date={plan.date} timeZone={plan.timeZone} />
        ))
      )}
    </div>
  );
}

export function PrintPlanPage() {
  const queryDate = typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("date")
    : null;
  const date = queryDate || todayInPlanZone();
  const [data, setData] = useState<PrintPlanData | null>(null);
  const [refusal, setRefusal] = useState<{ error: string; unpublishedTransfers: UnpublishedTransfer[] } | null>(null);
  const [message, setMessage] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setMessage("");
      setRefusal(null);
      try {
        const response = await send(`/daily-plans/${date}/print`, "GET");
        if (await redirectUnauthorized(response)) return;
        if (response.status === 409) {
          const body = await response.json() as { error: string; unpublishedTransfers: UnpublishedTransfer[] };
          setRefusal(body);
        } else if (!response.ok) {
          setMessage(await readError(response, "Unable to load print view"));
        } else {
          const result = await response.json() as PrintPlanData;
          setData(result);
        }
      } catch {
        setMessage("Unable to reach the server");
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, [date]);

  return (
    <main>
      <div className="no-print">
        <h1>Print / Export Plan diario</h1>
        <OfficeNav />
      </div>
      <style>{`
        @media print {
          .no-print {
            display: none !important;
          }
          .print-route-page {
            page-break-after: always;
            break-after: page;
            margin: 0;
            padding: 16px;
          }
          .print-route-page:last-child {
            page-break-after: avoid;
            break-after: avoid;
          }
          body {
            font-family: sans-serif;
            color: #000;
            background: #fff;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
          }
          th, td {
            border: 1px solid #333;
            padding: 4px 6px;
            text-align: left;
          }
          th {
            background: #eee;
          }
        }
        @media screen {
          .print-route-page {
            border: 1px solid #ccc;
            margin: 16px 0;
            padding: 16px;
            background: #fff;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
          }
          .print-toolbar {
            margin: 12px 0;
            display: flex;
            gap: 12px;
            align-items: center;
          }
          .print-stops-table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 12px;
          }
          .print-stops-table th, .print-stops-table td {
            border: 1px solid #ddd;
            padding: 6px 8px;
            text-align: left;
          }
          .print-stops-table th {
            background: #f5f5f5;
          }
        }
      `}</style>
      {loading && <p>Loading printable plan...</p>}
      {message && <p role="status">{message}</p>}
      {refusal && (
        <>
          <PrintRefusal error={refusal.error} unpublishedTransfers={refusal.unpublishedTransfers} />
          <p className="no-print"><a href={`/plan?date=${date}`}>Back to Plan diario</a></p>
        </>
      )}
      {data && <PrintPlanView plan={data.plan} routes={data.routes} />}
    </main>
  );
}
