import { randomBytes } from "node:crypto";
import type { BrowserContext } from "@playwright/test";
import pg from "pg";
import { hashSessionToken } from "../../../packages/api/src/auth.js";

export function database() {
  return new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL });
}

// Seeds a signed-in Oficina session without the login UI, so changes to the login flow do not break C3 tests.
export async function signInOffice(context: BrowserContext) {
  const token = randomBytes(32).toString("base64url");
  const pool = database();
  try {
    const user = await pool.query(
      "INSERT INTO users (username, password_hash, role) VALUES ($1, 'e2e-session-only', 'office') RETURNING id",
      [`office-${randomBytes(4).toString("hex")}`],
    );
    await pool.query("INSERT INTO sessions (user_id, token_hash, device_label) VALUES ($1, $2, 'Playwright')", [
      user.rows[0].id,
      hashSessionToken(token),
    ]);
  } finally {
    await pool.end();
  }
  await context.addCookies([{ name: "session", value: token, url: process.env.E2E_BASE_URL, httpOnly: true, secure: true, sameSite: "Lax" }]);
}
