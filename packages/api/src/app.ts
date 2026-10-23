import { getCookie, deleteCookie, setCookie } from "hono/cookie";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import type { ServerEpoch } from "@traslado/shared";
import { createSessionToken, hashPassword, hashSessionToken, normalizeUsername, verifyPassword } from "./auth.js";

type QueryResult = { rows: Record<string, unknown>[]; rowCount: number | null };
type Queryable = { query: (sql: string, values?: unknown[]) => Promise<unknown> };
type DatabaseClient = Queryable & { release: () => void };

export type HealthDatabase = Queryable & { connect?: () => Promise<DatabaseClient> };

export type AppConfig = {
  serverEpoch: ServerEpoch;
  healthTimeoutMs?: number;
  trustedOrigins?: string[];
  getClientIp?: (context: Context) => string;
};

type UserRow = { id: number; username: string; password_hash: string; role: string; disabled_at: string | null };
type AuthenticatedUser = { id: number; username: string; role: string; session_id: number };

const SESSION_COOKIE = "session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginFailures = new Map<string, { count: number; expiresAt: number }>();
const dummyPasswordHash = hashPassword("not-a-real-user-password");

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTrustedOrigin(origin: string | undefined, requestUrl: string, allowed: string[] = []) {
  if (!origin) return false;
  try {
    const supplied = new URL(origin).origin;
    return supplied === new URL(requestUrl).origin || allowed.some((candidate) => new URL(candidate).origin === supplied);
  } catch {
    return false;
  }
}

function clientIp(context: Context, config: AppConfig) {
  if (config.getClientIp) return config.getClientIp(context);
  try {
    return getConnInfo(context).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

function loginRateLimited(username: string, ip: string) {
  const now = Date.now();
  for (const [key, value] of loginFailures) if (value.expiresAt <= now) loginFailures.delete(key);
  return [`username:${username}`, `ip:${ip}`].some((key) => (loginFailures.get(key)?.count ?? 0) >= LOGIN_FAILURE_LIMIT);
}

function recordLoginFailure(username: string, ip: string) {
  const expiresAt = Date.now() + LOGIN_WINDOW_MS;
  for (const key of [`username:${username}`, `ip:${ip}`]) {
    const previous = loginFailures.get(key);
    loginFailures.set(key, { count: (previous && previous.expiresAt > Date.now() ? previous.count : 0) + 1, expiresAt });
  }
}

async function inTransaction<T>(db: HealthDatabase, work: (client: Queryable) => Promise<T>) {
  if (!db.connect) throw new Error("Database transactions are required for account writes");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function appendChange(
  client: Queryable,
  actorId: number | null,
  entity: string,
  entityId: string,
  action: string,
  before: unknown,
  after: unknown,
) {
  await client.query(
    "INSERT INTO change_log (actor_user_id, entity, entity_id, action, before_data, after_data) VALUES ($1, $2, $3, $4, $5, $6)",
    [actorId, entity, entityId, action, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after)],
  );
}

async function currentUser(db: HealthDatabase, context: Context): Promise<AuthenticatedUser | null> {
  const token = getCookie(context, SESSION_COOKIE);
  if (!token) return null;
  const result = await db.query(
    `SELECT u.id, u.username, u.role, s.id AS session_id
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.created_at > now() - interval '30 days'
        AND u.disabled_at IS NULL`,
    [hashSessionToken(token)],
  ) as QueryResult;
  return (result.rows[0] as AuthenticatedUser | undefined) ?? null;
}

function invalidCredentials(context: Context) {
  return context.json({ error: "Invalid username or password" }, 401);
}

function isOffice(user: AuthenticatedUser) {
  return user.role === "office";
}

export function createApp({ db, config }: { db: HealthDatabase; config: AppConfig }) {
  if (!config.serverEpoch.trim()) throw new Error("SERVER_EPOCH is required");
  const healthTimeoutMs = config.healthTimeoutMs ?? 1000;
  const app = new Hono()
    .use("*", async (context, next) => {
      try {
        await next();
      } finally {
        context.header("X-Server-Epoch", config.serverEpoch);
      }
    })
    .use("*", async (context, next) => {
      const origin = context.req.header("origin");
      const trusted = isTrustedOrigin(origin, context.req.url, config.trustedOrigins);
      if (trusted && origin) {
        context.header("Access-Control-Allow-Origin", origin);
        context.header("Access-Control-Allow-Credentials", "true");
        context.header("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
        context.header("Access-Control-Allow-Headers", "Content-Type");
        context.header("Vary", "Origin");
      }
      if (context.req.method === "OPTIONS") return context.body(null, 204);
      if (["POST", "PUT", "PATCH", "DELETE"].includes(context.req.method) && !trusted) {
        return context.json({ error: "Invalid origin" }, 403);
      }
      await next();
    })
    .get("/health", async (context) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          db.query("SELECT 1"),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Database health check timed out")), healthTimeoutMs);
          }),
        ]);
        return context.body(null, 200);
      } catch {
        return context.body(null, 503);
      } finally {
        if (timer) clearTimeout(timer);
      }
    })
    .post("/auth/login", async (context) => {
      const body = await context.req.json().catch(() => null);
      if (!isObject(body) || typeof body.username !== "string" || typeof body.password !== "string" || typeof body.deviceLabel !== "string") {
        return context.json({ error: "Invalid request" }, 400);
      }
      const username = normalizeUsername(body.username);
      const password = body.password;
      const deviceLabel = body.deviceLabel.trim();
      if (!username || !password || !deviceLabel || deviceLabel.length > 100) return context.json({ error: "Invalid request" }, 400);

      const ip = clientIp(context, config);
      if (loginRateLimited(username, ip)) {
        context.header("Retry-After", String(Math.ceil(LOGIN_WINDOW_MS / 1000)));
        return context.json({ error: "Too many login attempts" }, 429);
      }

      const accountResult = await db.query(
        "SELECT id, username, password_hash, role, disabled_at FROM users WHERE username = $1",
        [username],
      ) as QueryResult;
      const account = accountResult.rows[0] as UserRow | undefined;
      const verified = await verifyPassword(password, account?.password_hash ?? await dummyPasswordHash);
      if (!account || !verified || account.disabled_at) {
        recordLoginFailure(username, ip);
        return invalidCredentials(context);
      }

      const token = createSessionToken();
      const sessionId = await inTransaction(db, async (client) => {
        const inserted = await client.query(
          "INSERT INTO sessions (user_id, token_hash, device_label) VALUES ($1, $2, $3) RETURNING id",
          [account.id, hashSessionToken(token), deviceLabel],
        ) as QueryResult;
        const id = Number(inserted.rows[0]?.id);
        await appendChange(client, account.id, "session", String(id), "created", null, { deviceLabel });
        return id;
      });
      setCookie(context, SESSION_COOKIE, token, {
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
        path: "/",
        maxAge: SESSION_MAX_AGE_SECONDS,
      });
      return context.json({ user: { id: account.id, username: account.username, role: account.role }, sessionId });
    })
    .get("/auth/me", async (context) => {
      const user = await currentUser(db, context);
      if (!user) return context.json({ error: "Authentication required" }, 401);
      return context.json({ user: { id: user.id, username: user.username, role: user.role } });
    })
    .get("/auth/sessions", async (context) => {
      const user = await currentUser(db, context);
      if (!user) return context.json({ error: "Authentication required" }, 401);
      const result = await db.query(
        "SELECT id, device_label, created_at FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND created_at > now() - interval '30 days' ORDER BY created_at DESC",
        [user.id],
      ) as QueryResult;
      return context.json({ sessions: result.rows });
    })
    .post("/auth/logout", async (context) => {
      const user = await currentUser(db, context);
      if (user) {
        await inTransaction(db, async (client) => {
          await client.query("UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [user.session_id]);
          await appendChange(client, user.id, "session", String(user.session_id), "revoked", { active: true }, { active: false });
        });
      }
      deleteCookie(context, SESSION_COOKIE, { path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
      return context.body(null, 204);
    })
    .get("/users", async (context) => {
      const user = await currentUser(db, context);
      if (!user) return context.json({ error: "Authentication required" }, 401);
      if (!isOffice(user)) return context.json({ error: "Office role required" }, 403);
      const result = await db.query(
        "SELECT id, username, role, disabled_at, created_at FROM users ORDER BY username",
      ) as QueryResult;
      return context.json({ users: result.rows });
    })
    .post("/users", async (context) => {
      const actor = await currentUser(db, context);
      if (!actor) return context.json({ error: "Authentication required" }, 401);
      if (!isOffice(actor)) return context.json({ error: "Office role required" }, 403);
      const body = await context.req.json().catch(() => null);
      if (!isObject(body) || typeof body.username !== "string" || typeof body.password !== "string" || !["office", "driver"].includes(String(body.role))) {
        return context.json({ error: "Invalid request" }, 400);
      }
      const username = normalizeUsername(body.username);
      if (!username || !body.password) return context.json({ error: "Invalid request" }, 400);
      const passwordHash = await hashPassword(body.password);
      try {
        const created = await inTransaction(db, async (client) => {
          const result = await client.query(
            "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role, created_at",
            [username, passwordHash, body.role],
          ) as QueryResult;
          const createdUser = result.rows[0];
          await appendChange(client, actor.id, "user", String(createdUser.id), "created", null, {
            username: createdUser.username,
            role: createdUser.role,
          });
          return createdUser;
        });
        return context.json({ user: created }, 201);
      } catch (error) {
        if (isPostgresUniqueViolation(error)) return context.json({ error: "Username already exists" }, 409);
        throw error;
      }
    })
    .patch("/users/:id/password", async (context) => {
      const actor = await currentUser(db, context);
      if (!actor) return context.json({ error: "Authentication required" }, 401);
      if (!isOffice(actor)) return context.json({ error: "Office role required" }, 403);
      const body = await context.req.json().catch(() => null);
      const id = Number(context.req.param("id"));
      if (!Number.isSafeInteger(id) || id <= 0 || !isObject(body) || typeof body.password !== "string" || !body.password) {
        return context.json({ error: "Invalid request" }, 400);
      }
      const passwordHash = await hashPassword(body.password);
      const updated = await inTransaction(db, async (client) => {
        const previous = await client.query("SELECT id, username, role, disabled_at FROM users WHERE id = $1 FOR UPDATE", [id]) as QueryResult;
        const before = previous.rows[0];
        if (!before) return false;
        await client.query("UPDATE users SET password_hash = $1 WHERE id = $2", [passwordHash, id]);
        await client.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [id]);
        await appendChange(client, actor.id, "user", String(id), "password_reset", null, { username: before.username });
        return true;
      });
      return updated ? context.body(null, 204) : context.json({ error: "User not found" }, 404);
    })
    .patch("/users/:id/disable", async (context) => {
      const actor = await currentUser(db, context);
      if (!actor) return context.json({ error: "Authentication required" }, 401);
      if (!isOffice(actor)) return context.json({ error: "Office role required" }, 403);
      const id = Number(context.req.param("id"));
      if (!Number.isSafeInteger(id) || id <= 0) return context.json({ error: "Invalid request" }, 400);
      const disabled = await inTransaction(db, async (client) => {
        const result = await client.query(
          "UPDATE users SET disabled_at = now() WHERE id = $1 AND disabled_at IS NULL RETURNING id, username, role",
          [id],
        ) as QueryResult;
        const previous = result.rows[0];
        if (!previous) return null;
        await client.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [id]);
        await appendChange(client, actor.id, "user", String(id), "disabled", { disabled: false }, { disabled: true, username: previous.username, role: previous.role });
        return previous;
      });
      if (!disabled) {
        const existing = await db.query("SELECT id FROM users WHERE id = $1", [id]) as QueryResult;
        return existing.rows.length ? context.body(null, 204) : context.json({ error: "User not found" }, 404);
      }
      return context.body(null, 204);
    })
    .onError((_error, context) => {
      context.header("X-Server-Epoch", config.serverEpoch);
      return context.body(null, 500);
    });

  return app;
}

function isPostgresUniqueViolation(error: unknown): error is { code: string } {
  return isObject(error) && error.code === "23505";
}

export type AppType = ReturnType<typeof createApp>;
