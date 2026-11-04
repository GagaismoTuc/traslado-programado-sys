import { useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap, Marker } from "maplibre-gl";
import type { LiveRoute } from "@traslado/api";
import { MAP_STYLE_URL } from "./PinPicker";

type MapLibre = typeof import("maplibre-gl");

// San Miguel de Tucumán default center
const DEFAULT_CENTER: [number, number] = [-65.2036, -26.8241];

export type LiveMapProps = {
  routes: LiveRoute[];
  selectedRouteId: number | null;
  onSelectRoute?: (routeId: number) => void;
};

export function LiveMap({ routes, selectedRouteId, onSelectRoute }: LiveMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<{ library: MapLibre; map: MapLibreMap } | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  // Initialize MapLibre
  useEffect(() => {
    let cancelled = false;
    let instance: MapLibreMap | undefined;

    void Promise.all([
      import("maplibre-gl"),
      import("maplibre-gl/dist/maplibre-gl-worker.mjs?url"),
      import("maplibre-gl/dist/maplibre-gl.css"),
    ])
      .then(([library, worker]) => {
        if (cancelled || !container.current) return;
        library.setWorkerUrl(worker.default);
        instance = new library.Map({
          container: container.current,
          style: MAP_STYLE_URL,
          center: DEFAULT_CENTER,
          zoom: 12,
          attributionControl: false,
        });

        instance.on("load", () => {
          if (cancelled) return;
          mapRef.current = { library, map: instance! };
          setReady(true);
        });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      instance?.remove();
      mapRef.current = null;
    };
  }, []);

  // Update layers and markers when routes or ready changes
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    const { library, map } = mapRef.current;

    // Clear old markers
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    for (const route of routes) {
      // 1. Route line geometry
      const sourceId = `route-line-${route.id}`;
      const layerId = `route-layer-${route.id}`;

      if (route.geometry.length >= 2) {
        const geojson = {
          type: "Feature" as const,
          properties: { routeId: route.id },
          geometry: {
            type: "LineString" as const,
            coordinates: route.geometry,
          },
        };

        const existingSource = map.getSource(sourceId) as any;
        if (existingSource && typeof existingSource.setData === "function") {
          existingSource.setData(geojson);
        } else if (!map.getSource(sourceId)) {
          map.addSource(sourceId, {
            type: "geojson",
            data: geojson,
          });
          map.addLayer({
            id: layerId,
            type: "line",
            source: sourceId,
            layout: {
              "line-join": "round",
              "line-cap": "round",
            },
            paint: {
              "line-color": route.color,
              "line-width": selectedRouteId === route.id ? 6 : 4,
              "line-opacity": selectedRouteId !== null && selectedRouteId !== route.id ? 0.4 : 0.85,
            },
          });
        }
      }

      // 2. Stop markers
      for (const stop of route.stops) {
        const popupContent = document.createElement("div");
        popupContent.className = "live-map-popup";
        popupContent.innerHTML = `
          <strong>${stop.passengerName}</strong> (${stop.kind === "pickup" ? "Subida" : "Bajada"})<br/>
          <span>${stop.placeName}</span><br/>
          <span>Hora planificada: ${stop.plannedTime}</span>
          ${stop.eta ? `<br/><span>ETA: <strong>${stop.eta}</strong></span>` : ""}
          <br/><span>Estado: ${stop.completed ? stop.status : "Pendiente"}</span>
        `;

        const markerEl = document.createElement("div");
        markerEl.className = "live-stop-marker";
        markerEl.style.width = "18px";
        markerEl.style.height = "18px";
        markerEl.style.borderRadius = "50%";
        markerEl.style.backgroundColor = route.color;
        markerEl.style.border = "2px solid #ffffff";
        markerEl.style.boxShadow = "0 1px 3px rgba(0,0,0,0.3)";
        markerEl.title = `${stop.position}. ${stop.passengerName}`;

        const marker = new library.Marker({ element: markerEl })
          .setLngLat([stop.longitude, stop.latitude])
          .setPopup(new library.Popup({ offset: 12 }).setDOMContent(popupContent))
          .addTo(map);

        markersRef.current.push(marker);
      }

      // 3. Last-Marca marker (if any)
      if (route.lastMarca) {
        const marcaPopup = document.createElement("div");
        marcaPopup.className = "live-marca-popup";
        marcaPopup.innerHTML = `
          <strong>${route.vehicle.plate} (${route.driver.name})</strong><br/>
          <span>Última marca: <strong>${route.lastMarca.kind}</strong></span><br/>
          <span>Hora: ${route.lastMarca.phoneTimeHhmi}</span>
        `;

        const vehicleEl = document.createElement("div");
        vehicleEl.className = "live-vehicle-marker";
        vehicleEl.style.width = "28px";
        vehicleEl.style.height = "28px";
        vehicleEl.style.borderRadius = "6px";
        vehicleEl.style.backgroundColor = route.color;
        vehicleEl.style.border = "2px solid #ffffff";
        vehicleEl.style.color = "#ffffff";
        vehicleEl.style.display = "flex";
        vehicleEl.style.alignItems = "center";
        vehicleEl.style.justifyContent = "center";
        vehicleEl.style.fontSize = "14px";
        vehicleEl.style.boxShadow = "0 2px 5px rgba(0,0,0,0.4)";
        vehicleEl.innerHTML = "🚐";
        vehicleEl.title = `Vehículo ${route.vehicle.plate} - ${route.lastMarca.kind} a las ${route.lastMarca.phoneTimeHhmi}`;

        const marker = new library.Marker({ element: vehicleEl })
          .setLngLat([route.lastMarca.longitude, route.lastMarca.latitude])
          .setPopup(new library.Popup({ offset: 16 }).setDOMContent(marcaPopup))
          .addTo(map);

        markersRef.current.push(marker);
      }
    }
  }, [routes, ready, selectedRouteId]);

  return (
    <div
      ref={container}
      className="live-map"
      data-testid="live-map"
      style={{
        width: "100%",
        minHeight: "450px",
        height: "55vh",
        backgroundColor: "#e5e3df",
        position: "relative",
      }}
    >
      {!ready && !failed && (
        <div style={{ padding: "16px", color: "#666" }} data-testid="live-map-loading">
          Cargando mapa en vivo...
        </div>
      )}
      {failed && (
        <div style={{ padding: "16px", color: "#666" }} data-testid="live-map-fallback">
          El mapa interactivo no se pudo inicializar en este navegador.
        </div>
      )}
    </div>
  );
}
