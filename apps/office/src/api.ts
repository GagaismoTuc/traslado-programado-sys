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
