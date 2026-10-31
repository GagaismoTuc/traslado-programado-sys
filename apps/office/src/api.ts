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

/** The API's own `error` text when it sent one, otherwise the fallback. */
export async function readError(response: Response, fallback: string) {
  const result = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof result?.error === "string" ? result.error : fallback;
}

export async function isSecondFactorRequired(response: Response) {
  if (response.status !== 401) return false;
  const result = await response.clone().json().catch(() => null) as { code?: unknown } | null;
  return result?.code === "second_factor_required";
}

/** On a 401 sends the browser to `/second-factor` or to sign-in; true when it navigated. */
export async function redirectUnauthorized(...responses: Response[]) {
  for (const response of responses) {
    if (await isSecondFactorRequired(response)) {
      window.location.assign("/second-factor");
      return true;
    }
  }
  if (responses.some((response) => response.status === 401)) {
    window.location.assign("/");
    return true;
  }
  return false;
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
