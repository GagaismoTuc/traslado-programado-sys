import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { hashPassword, normalizeUsername } from "./auth.js";

type BootstrapPool = Pick<Pool, "connect">;
type Environment = Record<string, string | undefined>;

const BOOTSTRAP_LOCK_NAMESPACE = 841201;
const BOOTSTRAP_LOCK_KEY = 10;

export async function runBootstrapOffice(pool: BootstrapPool, args: string[], env: Environment) {
  if (args.length !== 1) throw new Error("Usage: db:bootstrap-office <username>");
  const username = normalizeUsername(args[0]);
  if (!username) throw new Error("Username is required");
  const password = env.BOOTSTRAP_OFFICE_PASSWORD;
  if (!password) throw new Error("BOOTSTRAP_OFFICE_PASSWORD is required");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [BOOTSTRAP_LOCK_NAMESPACE, BOOTSTRAP_LOCK_KEY]);
    const existingOffice = await client.query("SELECT id FROM users WHERE role = 'office' LIMIT 1");
    if (existingOffice.rows.length > 0) throw new Error("An Office account already exists");

    const passwordHash = await hashPassword(password);
    const created = await client.query(
      "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'office') RETURNING id, username",
      [username, passwordHash],
    );
    const user = created.rows[0] as { id: number; username: string };
    await client.query(
      "INSERT INTO change_log (actor_user_id, actor_label, entity, entity_id, action, before_data, after_data) VALUES (NULL, 'bootstrap', 'user', $1, 'created', NULL, $2)",
      [String(user.id), JSON.stringify({ username: user.username, role: "office" })],
    );
    await client.query("COMMIT");
    return user;
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
    const user = await runBootstrapOffice(pool, process.argv.slice(2), process.env);
    console.info(`Created initial Office account: ${user.username}`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Office bootstrap failed");
    process.exitCode = 1;
  });
}
