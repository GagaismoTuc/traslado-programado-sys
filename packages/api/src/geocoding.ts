export type GeocodeResult = { lat: number; lng: number; displayName: string };

// Resolves one address to its best match, or null when nothing matches.
export type Geocoder = (query: string) => Promise<GeocodeResult | null>;

type NominatimOptions = {
  url: string;
  userAgent: string;
  timeoutMs?: number;
  fetch?: (input: URL, init: RequestInit) => Promise<Response>;
};

// Fixed parameters from the Nominatim usage policy: one best match, restricted to Argentina, in Spanish.
const SEARCH_PARAMETERS = { format: "jsonv2", limit: "1", countrycodes: "ar", "accept-language": "es" };

export function createNominatimGeocoder({ url, userAgent, timeoutMs = 5000, fetch: send = fetch }: NominatimOptions): Geocoder {
  return async (query) => {
    const endpoint = new URL("/search", url);
    endpoint.search = new URLSearchParams({ q: query, ...SEARCH_PARAMETERS }).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Nominatim timed out")), timeoutMs);
    try {
      const response = await send(endpoint, { headers: { "User-Agent": userAgent, Accept: "application/json" }, signal: controller.signal });
      if (!response.ok) throw new Error(`Nominatim answered ${response.status}`);
      const results: unknown = await response.json();
      if (!Array.isArray(results) || results.length === 0) return null;
      const { lat, lon, display_name: displayName } = results[0] as Record<string, unknown>;
      const point = { lat: Number(lat), lng: Number(lon) };
      if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng) || typeof displayName !== "string") {
        throw new Error("Nominatim answered an unexpected result");
      }
      return { ...point, displayName };
    } finally {
      clearTimeout(timer);
    }
  };
}
