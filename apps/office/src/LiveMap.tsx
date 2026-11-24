import { useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap, Marker } from "maplibre-gl";
import type { LiveCurrentPosition, LiveRoute, LiveStop } from "@traslado/api";
import type { TrailPoint } from "./api";
import { MAP_STYLE_URL } from "./PinPicker";

type MapLibre = typeof import("maplibre-gl");

export function createStopPopupContent(stop: LiveStop): HTMLElement {
  const container = document.createElement("div");
  container.className = "live-map-popup";

  const title = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = stop.passengerName;
  title.appendChild(strong);
  title.appendChild(document.createTextNode(` (${stop.kind === "pickup" ? "Subida" : "Bajada"})`));
  container.appendChild(title);

  const place = document.createElement("div");
  place.textContent = stop.placeName;
  container.appendChild(place);

  const planned = document.createElement("div");
  planned.textContent = `Hora planificada: ${stop.plannedTime}`;
  container.appendChild(planned);

  if (stop.eta) {
    const etaRow = document.createElement("div");
    etaRow.appendChild(document.createTextNode("ETA: "));
    const etaStrong = document.createElement("strong");
    etaStrong.textContent = stop.eta;
    etaRow.appendChild(etaStrong);
    container.appendChild(etaRow);
  }

  const status = document.createElement("div");
  status.textContent = `Estado: ${stop.completed ? stop.status : "Pendiente"}`;
  container.appendChild(status);

  return container;
}

/** Where the 🚐 marker's position comes from and when: "Celular, 08:12" or "Última marca, 08:14". */
export function currentPositionLabel(position: LiveCurrentPosition): string {
  return `${position.source === "posicion" ? "Celular" : "Última marca"}, ${position.phoneTimeHhmi}`;
}

const LIVE_AGE_MS = 60_000;
const STALE_AFTER_MS = 120_000;
export const STALE_MARKER_COLOR = "#6c757d";

/**
 * Age of a Recorrido's latest Posición against the browser clock: "en vivo" up to 60 s, "hace N s" up to 2 min,
 * then a Posición desactualizada. A phone time in the future counts as age 0. A position from a Marca, or a
 * closed Recorrido, has no Seguimiento age (null).
 */
export function positionAge(
  position: LiveCurrentPosition,
  routeStatus: string,
  nowMs = Date.now(),
): { label: string; stale: boolean } | null {
  if (position.source !== "posicion" || routeStatus === "cerrado") return null;
  const ageMs = Math.max(0, nowMs - Date.parse(position.phoneTime));
  if (ageMs <= LIVE_AGE_MS) return { label: "en vivo", stale: false };
  if (ageMs <= STALE_AFTER_MS) return { label: `hace ${Math.floor(ageMs / 1000)} s`, stale: false };
  return { label: `sin posición desde ${position.phoneTimeHhmi}`, stale: true };
}

/** Popup of the 🚐 marker: the Vehículo and Chofer, the origin of its position and its time. */
export function createMarcaPopupContent(
  vehiclePlate: string,
  driverName: string,
  origin: string,
  phoneTimeHhmi: string,
): HTMLElement {
  const container = document.createElement("div");
  container.className = "live-marca-popup";

  const title = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = `${vehiclePlate} (${driverName})`;
  title.appendChild(strong);
  container.appendChild(title);

  const marcaRow = document.createElement("div");
  marcaRow.appendChild(document.createTextNode("Posición: "));
  const marcaStrong = document.createElement("strong");
  marcaStrong.textContent = origin;
  marcaRow.appendChild(marcaStrong);
  container.appendChild(marcaRow);

  const timeRow = document.createElement("div");
  timeRow.textContent = `Hora: ${phoneTimeHhmi}`;
  container.appendChild(timeRow);

  return container;
}

// San Miguel de Tucumán default center
const DEFAULT_CENTER: [number, number] = [-65.2036, -26.8241];

/** The Rastro loaded for one Recorrido. */
export type RouteTrail = { routeId: number; points: TrailPoint[] };

export type LiveMapProps = {
  routes: LiveRoute[];
  selectedRouteId: number | null;
  trail?: RouteTrail | null;
  onSelectRoute?: (routeId: number) => void;
};

export type MapInstanceLike = {
  getLayer(id: string): any;
  removeLayer(id: string): void;
  getSource(id: string): any;
  removeSource(id: string): void;
  addSource(id: string, source: any): void;
  addLayer(layer: any): void;
  setPaintProperty(layerId: string, name: string, value: any): void;
};

export type MarkerLike = {
  remove(): void;
  setLngLat(lngLat: [number, number]): any;
  setPopup(popup: any): any;
  addTo(map: any): any;
};

export function updateMapRoutes(
  map: MapInstanceLike,
  library: { Marker: new (options?: { element?: HTMLElement }) => MarkerLike; Popup: any },
  routes: LiveRoute[],
  selectedRouteId: number | null,
  markersRef: { current: MarkerLike[] },
  renderedRouteIdsRef: { current: Set<number> },
  nowMs = Date.now(),
) {
  // Remove layers and sources for routes no longer present (Regla 3)
  const currentRouteIds = new Set(routes.map((r) => r.id));
  for (const oldId of renderedRouteIdsRef.current) {
    if (!currentRouteIds.has(oldId)) {
      const layerId = `route-layer-${oldId}`;
      const sourceId = `route-line-${oldId}`;
      if (map.getLayer(layerId)) {
        map.removeLayer(layerId);
      }
      if (map.getSource(sourceId)) {
        map.removeSource(sourceId);
      }
    }
  }
  renderedRouteIdsRef.current = currentRouteIds;

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
        if (map.getLayer(layerId)) {
          map.setPaintProperty(layerId, "line-width", selectedRouteId === route.id ? 6 : 4);
          map.setPaintProperty(layerId, "line-opacity", selectedRouteId !== null && selectedRouteId !== route.id ? 0.4 : 0.85);
          map.setPaintProperty(layerId, "line-color", route.color);
        }
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
            // The planned line is dashed; the Rastro (what the phone did) is the solid line.
            "line-dasharray": [2, 2],
          },
        });
      }
    } else {
      if (map.getLayer(layerId)) {
        map.removeLayer(layerId);
      }
      if (map.getSource(sourceId)) {
        map.removeSource(sourceId);
      }
    }

    // 2. Stop markers
    for (const stop of route.stops) {
      const popupContent = createStopPopupContent(stop);

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

    // 3. Vehicle marker at the current position: the latest Posición or located Marca; none without one (never invented)
    const position = route.currentPosition;
    if (position) {
      const marcaPopup = createMarcaPopupContent(
        route.vehicle.plate,
        route.driver.name,
        position.source === "posicion" ? "Celular" : "Última marca",
        position.phoneTimeHhmi,
      );

      const vehicleEl = document.createElement("div");
      vehicleEl.className = "live-vehicle-marker";
      vehicleEl.style.width = "28px";
      vehicleEl.style.height = "28px";
      vehicleEl.style.borderRadius = "6px";
      const age = positionAge(position, route.status, nowMs);
      vehicleEl.style.backgroundColor = age?.stale ? STALE_MARKER_COLOR : route.color;
      vehicleEl.style.border = "2px solid #ffffff";
      vehicleEl.style.color = "#ffffff";
      vehicleEl.style.display = "flex";
      vehicleEl.style.alignItems = "center";
      vehicleEl.style.justifyContent = "center";
      vehicleEl.style.fontSize = "14px";
      vehicleEl.style.boxShadow = "0 2px 5px rgba(0,0,0,0.4)";
      vehicleEl.textContent = "🚐";
      vehicleEl.title = `Vehículo ${route.vehicle.plate} - ${currentPositionLabel(position)}${age ? ` (${age.label})` : ""}`;

      const marker = new library.Marker({ element: vehicleEl })
        .setLngLat([position.longitude, position.latitude])
        .setPopup(new library.Popup({ offset: 16 }).setDOMContent(marcaPopup))
        .addTo(map);

      markersRef.current.push(marker);
    }
  }
}

/**
 * Draws the chosen Recorrido's Rastro as a solid line in its color, and removes the Rastro of any previous
 * selection (another Recorrido, another date or none), the same way updateMapRoutes removes stale layers.
 */
export function updateMapTrail(
  map: MapInstanceLike,
  routes: LiveRoute[],
  trail: RouteTrail | null,
  renderedTrailRef: { current: number | null },
) {
  const route = trail ? routes.find((candidate) => candidate.id === trail.routeId) : undefined;
  const drawId = trail && route && trail.points.length >= 2 ? trail.routeId : null;

  if (renderedTrailRef.current !== null && renderedTrailRef.current !== drawId) {
    const oldId = renderedTrailRef.current;
    if (map.getLayer(`route-trail-layer-${oldId}`)) map.removeLayer(`route-trail-layer-${oldId}`);
    if (map.getSource(`route-trail-${oldId}`)) map.removeSource(`route-trail-${oldId}`);
  }
  renderedTrailRef.current = drawId;
  if (drawId === null || !trail || !route) return;

  const sourceId = `route-trail-${drawId}`;
  const layerId = `route-trail-layer-${drawId}`;
  const geojson = {
    type: "Feature" as const,
    properties: { routeId: drawId },
    geometry: { type: "LineString" as const, coordinates: trail.points.map((point) => [point.lng, point.lat]) },
  };
  const existingSource = map.getSource(sourceId) as any;
  if (existingSource && typeof existingSource.setData === "function") {
    existingSource.setData(geojson);
    if (map.getLayer(layerId)) map.setPaintProperty(layerId, "line-color", route.color);
    return;
  }
  if (existingSource) return;
  map.addSource(sourceId, { type: "geojson", data: geojson });
  map.addLayer({
    id: layerId,
    type: "line",
    source: sourceId,
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": route.color, "line-width": 5, "line-opacity": 0.95 },
  });
}

export function LiveMap({ routes, selectedRouteId, trail = null, onSelectRoute }: LiveMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<{ library: MapLibre; map: MapLibreMap } | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const renderedRouteIdsRef = useRef<Set<number>>(new Set());
  const renderedTrailRef = useRef<number | null>(null);
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
      renderedRouteIdsRef.current.clear();
      renderedTrailRef.current = null;
      instance?.remove();
      mapRef.current = null;
    };
  }, []);

  // Update layers and markers when routes or ready changes
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    const { library, map } = mapRef.current;
    updateMapRoutes(map, library, routes, selectedRouteId, markersRef, renderedRouteIdsRef);
  }, [routes, ready, selectedRouteId]);

  // The Rastro goes on top of the planned lines; only the chosen Recorrido's one is ever on the map
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    updateMapTrail(mapRef.current.map, routes, trail?.routeId === selectedRouteId ? trail : null, renderedTrailRef);
  }, [routes, ready, selectedRouteId, trail]);

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
