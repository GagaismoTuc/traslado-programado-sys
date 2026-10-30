import type { LatLng } from "./PinPicker";

export const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export async function send(path: string, method: string, body?: unknown) {
  return fetch(`${apiUrl}${path}`, {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

const geocodeErrors: Record<number, string> = {
  404: "No match for this address. Place the pin on the map by hand.",
  429: "Too many address searches. Wait a second and try again, or place the pin on the map by hand.",
};

export type AddressSuggestionResult =
  | { ok: true; point: LatLng; message: string }
  | { ok: false; message: string };

export async function suggestAddressPin(rawAddress: string): Promise<AddressSuggestionResult> {
  const query = rawAddress.trim();
  if (!query) return { ok: false, message: "Write the address first." };
  try {
    const response = await send("/geocode", "POST", { query });
    if (response.ok) {
      const result = await response.json() as LatLng & { displayName: string };
      return {
        ok: true,
        point: { lat: result.lat, lng: result.lng },
        message: `Suggested: ${result.displayName}. Confirm the pin or move it.`,
      };
    }
    return {
      ok: false,
      message: geocodeErrors[response.status] ?? "Address search is unavailable. Place the pin on the map by hand.",
    };
  } catch {
    return { ok: false, message: "Address search is unavailable. Place the pin on the map by hand." };
  }
}
