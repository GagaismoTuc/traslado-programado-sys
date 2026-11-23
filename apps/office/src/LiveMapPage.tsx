import { useEffect, useState } from "react";
import type { LiveDailyPlan } from "@traslado/api";
import { redirectUnauthorized, send } from "./api";
import { currentPositionLabel, LiveMap } from "./LiveMap";
import { OfficeNav } from "./OfficeNav";

const PLAN_TIME_ZONE = "America/Argentina/Tucuman";

export function todayInPlanZone(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: PLAN_TIME_ZONE }).format(now);
}

export function LiveMapPage({ initialData }: { initialData?: LiveDailyPlan } = {}) {
  const [date, setDate] = useState(todayInPlanZone);
  const [data, setData] = useState<LiveDailyPlan | null>(initialData ?? null);
  const [loading, setLoading] = useState(initialData ? false : true);
  const [error, setError] = useState("");
  const [selectedRouteId, setSelectedRouteId] = useState<number | null>(null);

  useEffect(() => {
    if (initialData) return;
    let cancelled = false;

    async function load() {
      try {
        const response = await send(`/daily-plans/${date}/live`, "GET");
        if (await redirectUnauthorized(response)) return;
        if (cancelled) return;
        if (response.status === 404) {
          setData(null);
          setError("No hay plan diario para esta fecha");
          return;
        }
        if (!response.ok) {
          setError("Error al cargar datos en vivo");
          return;
        }
        const json = await response.json() as LiveDailyPlan;
        if (!cancelled) {
          setData(json);
          setError("");
        }
      } catch {
        if (!cancelled) setError("Error de conexión");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    setLoading(true);
    void load();
    // Auto-refresh by polling every ~15 s
    const interval = setInterval(() => {
      void load();
    }, 15000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [date]);

  return (
    <main style={{ padding: "16px", maxWidth: "1400px", margin: "0 auto" }}>
      <h1>Mapa en vivo / Live map</h1>
      <OfficeNav />

      <div style={{ marginTop: "12px", marginBottom: "16px", display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap" }}>
        <label>
          <strong>Fecha:</strong>{" "}
          <input
            type="date"
            name="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        {loading && <span role="status">Actualizando...</span>}
      </div>

      <div
        role="note"
        className="eta-disclaimer"
        data-testid="eta-disclaimer"
        style={{
          backgroundColor: "#fff3cd",
          color: "#664d03",
          border: "1px solid #ffecb5",
          borderRadius: "6px",
          padding: "10px 14px",
          marginBottom: "16px",
          fontSize: "14px",
          fontWeight: 500,
        }}
      >
        ⚠️ Las horas estimadas (ETA) son aproximadas (sin tráfico en tiempo real) / ETAs are approximate (no live traffic).
      </div>

      {error && <p role="alert" style={{ color: "#b02a37" }}>{error}</p>}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(320px, 1fr) 2fr", gap: "20px" }}>
        {/* Panel listing per Recorrido */}
        <aside
          aria-label="Recorridos del día"
          className="live-panel"
          data-testid="live-panel"
          style={{
            backgroundColor: "#fdfdfd",
            border: "1px solid #dee2e6",
            borderRadius: "8px",
            padding: "16px",
            maxHeight: "75vh",
            overflowY: "auto",
          }}
        >
          <h2 style={{ marginTop: 0 }}>Recorridos ({data?.routes.length ?? 0})</h2>

          {(!data || data.routes.length === 0) && (
            <p style={{ color: "#6c757d" }}>No hay recorridos planificados para este día.</p>
          )}

          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {data?.routes.map((route) => {
              const isSelected = selectedRouteId === route.id;
              return (
                <li
                  key={route.id}
                  data-testid={`route-card-${route.id}`}
                  onClick={() => setSelectedRouteId(isSelected ? null : route.id)}
                  style={{
                    border: isSelected ? `2px solid ${route.color}` : "1px solid #e9ecef",
                    borderLeft: `6px solid ${route.color}`,
                    borderRadius: "6px",
                    padding: "12px",
                    marginBottom: "12px",
                    backgroundColor: isSelected ? "#f8f9fa" : "#ffffff",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                    <span style={{ fontWeight: 600, fontSize: "16px" }}>
                      Recorrido #{route.id}
                    </span>
                    <span
                      style={{
                        fontSize: "12px",
                        padding: "2px 8px",
                        borderRadius: "10px",
                        backgroundColor: route.status === "en_curso" ? "#d1e7dd" : "#e2e3e5",
                        color: route.status === "en_curso" ? "#0f5132" : "#41464b",
                        fontWeight: 500,
                      }}
                    >
                      {route.status}
                    </span>
                  </div>

                  <div style={{ fontSize: "14px", lineHeight: "1.6" }}>
                    <div>
                      <strong>Vehículo:</strong> <span data-testid={`route-vehicle-${route.id}`}>{route.vehicle.plate}</span>
                    </div>
                    <div>
                      <strong>Chofer:</strong> <span data-testid={`route-driver-${route.id}`}>{route.driver.name}</span>
                    </div>
                    <div>
                      <strong>Pasajeros a bordo:</strong>{" "}
                      <span data-testid={`route-boarded-${route.id}`}>{route.childrenOnBoard}</span>
                      {route.passengersOnBoard.length > 0 && (
                        <>
                          {" "}(<span data-testid={`route-boarded-names-${route.id}`}>
                            {route.passengersOnBoard.map((passenger) => passenger.name).join(", ")}
                          </span>)
                        </>
                      )}
                    </div>
                    <div>
                      <strong>Próxima parada:</strong>{" "}
                      <span data-testid={`route-next-stop-${route.id}`}>
                        {route.nextStop
                          ? `${route.nextStop.passengerName} (${route.nextStop.kind === "pickup" ? "Subida" : "Bajada"}) - ${route.nextStop.placeName}`
                          : "Sin paradas pendientes"}
                      </span>
                    </div>
                    <div>
                      {route.lastMarca || route.currentPosition ? (
                        <>
                          <strong>ETA:</strong>{" "}
                          <span
                            data-testid={`route-eta-${route.id}`}
                            style={{ fontWeight: 600, color: route.nextStop?.eta ? "#0d6efd" : "inherit" }}
                          >
                            {route.nextStop ? (route.nextStop.eta ?? "No disponible") : "-"}
                          </span>
                        </>
                      ) : (
                        <>
                          <strong>Hora planificada:</strong>{" "}
                          <span data-testid={`route-eta-${route.id}`}>
                            {route.nextStop ? route.nextStop.plannedTime : "-"}
                          </span>
                        </>
                      )}
                    </div>
                    {route.currentPosition && (
                      <div style={{ color: "#495057", fontSize: "13px", marginTop: "4px" }}>
                        <strong>Posición:</strong>{" "}
                        <span data-testid={`route-position-${route.id}`}>{currentPositionLabel(route.currentPosition)}</span>
                      </div>
                    )}
                    {route.lastMarca && (
                      <div style={{ color: "#495057", fontSize: "13px", marginTop: "4px" }}>
                        <em>
                          Última marca: {route.lastMarca.kind} a las {route.lastMarca.phoneTimeHhmi}
                        </em>
                      </div>
                    )}
                  </div>

                  {/* Stop list for this route */}
                  <details style={{ marginTop: "10px", fontSize: "13px" }} open={isSelected}>
                    <summary style={{ cursor: "pointer", color: "#0d6efd" }}>
                      Paradas ({route.stops.length})
                    </summary>
                    <ol style={{ paddingLeft: "20px", marginTop: "8px" }}>
                      {route.stops.map((stop) => (
                        <li key={stop.id} style={{ marginBottom: "6px" }}>
                          <span>
                            <strong>{stop.passengerName}</strong> ({stop.kind === "pickup" ? "Subida" : "Bajada"}):{" "}
                            {stop.placeName}
                          </span>
                          <div style={{ color: "#6c757d", fontSize: "12px" }}>
                            Planificada: {stop.plannedTime}
                            {stop.eta && <> | ETA: <strong style={{ color: "#0d6efd" }}>{stop.eta}</strong></>}
                            {stop.eta === null && (route.lastMarca || route.currentPosition) && !stop.completed && <> | ETA: <em>no disponible</em></>}
                            {" "}| Estado: {stop.completed ? stop.status : "Pendiente"}
                          </div>
                        </li>
                      ))}
                    </ol>
                  </details>
                </li>
              );
            })}
          </ul>
        </aside>

        {/* Map view */}
        <div data-testid="live-map-container" style={{ borderRadius: "8px", overflow: "hidden", border: "1px solid #dee2e6" }}>
          <LiveMap
            routes={data?.routes ?? []}
            selectedRouteId={selectedRouteId}
            onSelectRoute={setSelectedRouteId}
          />
        </div>
      </div>
    </main>
  );
}

