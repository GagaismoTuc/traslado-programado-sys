import { useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap, Marker } from "maplibre-gl";

export type LatLng = { lat: number; lng: number };

type PinPickerProps = {
  // The confirmed pin, or null while there is none.
  value: LatLng | null;
  // Called when the user places, drags or confirms a pin: each of those gestures confirms it.
  onChange: (value: LatLng) => void;
  // A pin proposed by someone else (such as a geocoder), shown until the user confirms or moves it.
  suggestion: LatLng | null;
};

export const MAP_STYLE_URL = import.meta.env.VITE_MAP_STYLE_URL || "https://tiles.openfreemap.org/styles/liberty";
const ATTRIBUTION = '<a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> '
  + '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors';
// San Miguel de Tucumán.
const DEFAULT_CENTER: [number, number] = [-65.2036, -26.8241];

type MapLibre = typeof import("maplibre-gl");

function placeMarker(
  library: MapLibre,
  map: MapLibreMap,
  current: Marker | null,
  point: LatLng | null,
  options: { className: string; color?: string },
  onDrag: (point: LatLng) => void,
) {
  if (!point) {
    current?.remove();
    return null;
  }
  if (current) return current.setLngLat([point.lng, point.lat]);
  const marker = new library.Marker({ draggable: true, ...options }).setLngLat([point.lng, point.lat]).addTo(map);
  marker.on("dragend", () => {
    const { lat, lng } = marker.getLngLat();
    onDrag({ lat, lng });
  });
  return marker;
}

export function PinPicker({ value, onChange, suggestion }: PinPickerProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<{ library: MapLibre; map: MapLibreMap } | null>(null);
  const pin = useRef<Marker | null>(null);
  const suggested = useRef<Marker | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let instance: MapLibreMap | undefined;
    void Promise.all([
      import("maplibre-gl"),
      // Bundling moves maplibre-gl away from its worker file, so the worker URL is set explicitly.
      import("maplibre-gl/dist/maplibre-gl-worker.mjs?url"),
      import("maplibre-gl/dist/maplibre-gl.css"),
    ]).then(([library, worker]) => {
      if (cancelled || !container.current) return;
      library.setWorkerUrl(worker.default);
      instance = new library.Map({
        container: container.current,
        style: MAP_STYLE_URL,
        center: value ? [value.lng, value.lat] : DEFAULT_CENTER,
        zoom: 13,
        attributionControl: false,
      });
      instance.addControl(new library.AttributionControl({ compact: false, customAttribution: ATTRIBUTION }));
      instance.addControl(new library.NavigationControl({ showCompass: false }));
      instance.on("click", (event) => onChangeRef.current({ lat: event.lngLat.lat, lng: event.lngLat.lng }));
      map.current = { library, map: instance };
      setReady(true);
    }).catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
      instance?.remove();
      map.current = pin.current = suggested.current = null;
    };
  }, []);

  useEffect(() => {
    if (!ready || !map.current) return;
    pin.current = placeMarker(map.current.library, map.current.map, pin.current, value, { className: "pin-picker-pin" },
      (point) => onChangeRef.current(point));
  }, [ready, value]);

  useEffect(() => {
    if (!ready || !map.current) return;
    suggested.current = placeMarker(map.current.library, map.current.map, suggested.current, suggestion,
      { className: "pin-picker-suggestion", color: "#d97706" }, (point) => onChangeRef.current(point));
    if (suggestion) map.current.map.jumpTo({ center: [suggestion.lng, suggestion.lat] });
  }, [ready, suggestion]);

  return <div>
    <div ref={container} data-testid="pin-picker-map" style={{ height: 400 }}
      aria-label="Map: click to place the pin, drag the pin to move it" />
    {failed && <p role="alert">Unable to load the map</p>}
    <p>{value
      ? `Pin: ${value.lat.toFixed(6)}, ${value.lng.toFixed(6)}`
      : suggestion ? "Suggested pin: confirm it or move it" : "No pin yet: click the map to place it"}</p>
    {suggestion && <button type="button" onClick={() => onChange(suggestion)}>Confirm suggested pin</button>}
  </div>;
}
