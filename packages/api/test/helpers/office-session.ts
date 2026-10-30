import type { Pool } from "pg";

type RequestApp = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

export function getSessionCookie(response: Response) {
  const cookie = response.headers.get("set-cookie");
  const token = cookie?.match(/(?:^|, )session=([^;]+)/)?.[1];
  if (!cookie || !token) throw new Error("session cookie was not set");
  return { cookie: `session=${token}`, header: cookie };
}

/**
 * Signs an Oficina account in through `POST /auth/login` and marks that session as having passed the second factor,
 * so tests that are not about TOTP get a fully authenticated Oficina session.
 */
export async function signInOffice(app: RequestApp, migrationPool: Pool, username: string, password: string, deviceLabel = "Test browser") {
  const response = await app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify({ username, password, deviceLabel }),
  });
  if (response.status !== 200) throw new Error(`Oficina sign-in failed with ${response.status}`);
  const { sessionId } = await response.clone().json() as { sessionId: number };
  await migrationPool.query("UPDATE sessions SET second_factor_at = created_at WHERE id = $1", [sessionId]);
  return { ...getSessionCookie(response), sessionId, response };
}
