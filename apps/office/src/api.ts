export const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export async function send(path: string, method: string, body?: unknown) {
  return fetch(`${apiUrl}${path}`, {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}
