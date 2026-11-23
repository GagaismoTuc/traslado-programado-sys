import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { hashPassword, normalizeUsername } from "./auth.js";

type BreakGlassPool = Pick<Pool, "connect">;
type Environment = Record<string, string | undefined>;

/** Resets an Oficina account's password and TOTP when nobody can sign in; the password comes from the environment only. */
export async function runBreakGlassOffice(pool: BreakGlassPool, args: string[], env: Environment) {
  if (args.length !== 1) throw new Error("Usage: db:break-glass-office <username>");
  const username = normalizeUsername(args[0]);
  if (!username) throw new Error("Username is required");
  const password = env.BREAK_GLASS_OFFICE_PASSWORD;
  if (!password) throw new Error("BREAK_GLASS_OFFICE_PASSWORD is required");
  const passwordHash = await hashPassword(password);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query("SELECT id, role, disabled_at FROM users WHERE username = $1 FOR UPDATE", [username]);
    const user = found.rows[0] as { id: number; role: string; disabled_at: Date | null } | undefined;
    if (!user) throw new Error(`No account named ${username}`);
    if (user.role !== "office") throw new Error(`${username} is not an Office account`);
    if (user.disabled_at) throw new Error(`${username} is disabled`);
    await client.query(
      "UPDATE users SET password_hash = $2, totp_secret = NULL, totp_confirmed_at = NULL, totp_last_step = NULL WHERE id = $1",
      [user.id, passwordHash],
    );
    await client.query(
      "UPDATE sessions SET revoked_at = now(), ended_reason = 'break_glass' WHERE user_id = $1 AND revoked_at IS NULL",
      [user.id],
    );
    await client.query("DELETE FROM remembered_devices WHERE user_id = $1", [user.id]);
    await client.query("DELETE FROM push_subscriptions WHERE session_id IN (SELECT id FROM sessions WHERE user_id = $1)", [user.id]);
    await client.query(
      "INSERT INTO change_log (actor_user_id, actor_label, entity, entity_id, action, before_data, after_data) VALUES (NULL, 'break-glass', 'user', $1, 'break_glass', NULL, $2)",
      [String(user.id), JSON.stringify({ username, totpReset: true })],
    );
    await client.query("COMMIT");
    return { id: user.id, username };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function required(name: string, env: Environment) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const pool = new Pool({ connectionString: required("BOOTSTRAP_DATABASE_URL", process.env), options: "-c timezone=UTC" });
  try {
    const user = await runBreakGlassOffice(pool, process.argv.slice(2), process.env);
    console.info(`Reset password and two-factor authentication for Office account: ${user.username}`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Office break-glass failed");
    process.exitCode = 1;
  });
}
