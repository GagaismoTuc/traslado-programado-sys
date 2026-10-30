import { getCookie, deleteCookie, setCookie } from "hono/cookie";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import type { ServerEpoch } from "@traslado/shared";
import { createSessionToken, hashPassword, hashSessionToken, normalizeUsername, verifyPassword } from "./auth.js";
import type { GeocodeResult, Geocoder } from "./geocoding.js";

type QueryResult = { rows: Record<string, unknown>[]; rowCount: number | null };
type Queryable = { query: (sql: string, values?: unknown[]) => Promise<unknown> };
type DatabaseClient = Queryable & { release: () => void };

export type HealthDatabase = Queryable & { connect?: () => Promise<DatabaseClient> };

export type HealthProbe = (signal: AbortSignal) => Promise<unknown>;

export type RoutingHealth = {
  osrm: HealthProbe;
  vroom: HealthProbe;
};

export type AppConfig = {
  serverEpoch: ServerEpoch;
  healthTimeoutMs?: number;
  trustedOrigins?: string[];
  getClientIp?: (context: Context) => string;
  now?: () => number;
};

type UserRow = { id: number; username: string; password_hash: string; role: string; disabled_at: string | null };
type AuthenticatedUser = { id: number; username: string; role: string; session_id: number };

const SESSION_COOKIE = "session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginFailures = new Map<string, { count: number; expiresAt: number }>();
const loginAttempts = new Map<string, number>();
const dummyPasswordHash = hashPassword("not-a-real-user-password");
const GEOCODE_INTERVAL_MS = 1000;
const GEOCODE_CACHE_LIMIT = 500;
const DESTINATION_KINDS = ["school", "clinic", "therapy", "day_centre", "other"];
const DESTINATION_COLUMNS =
  `id, name, kind, address, access_notes AS "accessNotes", latitude AS lat, longitude AS lng, created_at AS "createdAt"`;
const VEHICLE_FEATURE_COLUMNS = `id, name, created_at AS "createdAt"`;

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

function reserveLoginAttempt(username: string, ip: string) {
  const now = Date.now();
  for (const [key, value] of loginFailures) if (value.expiresAt <= now) loginFailures.delete(key);
  const keys = [`username:${username}`, `ip:${ip}`];
  if (keys.some((key) => (loginFailures.get(key)?.count ?? 0) + (loginAttempts.get(key) ?? 0) >= LOGIN_FAILURE_LIMIT)) {
    return null;
  }
  for (const key of keys) loginAttempts.set(key, (loginAttempts.get(key) ?? 0) + 1);
  return { keys, username, ip };
}

function recordLoginFailure(username: string, ip: string) {
  const expiresAt = Date.now() + LOGIN_WINDOW_MS;
  for (const key of [`username:${username}`, `ip:${ip}`]) {
    const previous = loginFailures.get(key);
    loginFailures.set(key, { count: (previous && previous.expiresAt > Date.now() ? previous.count : 0) + 1, expiresAt });
  }
}

function finishLoginAttempt(reservation: NonNullable<ReturnType<typeof reserveLoginAttempt>>, failed: boolean) {
  for (const key of reservation.keys) {
    const pending = loginAttempts.get(key) ?? 0;
    if (pending <= 1) loginAttempts.delete(key);
    else loginAttempts.set(key, pending - 1);
  }
  if (failed) recordLoginFailure(reservation.username, reservation.ip);
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

function boundedText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= maxLength ? text : null;
}

function coordinate(value: unknown, limit: number) {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
}

function parseDestination(body: unknown) {
  if (!isObject(body)) return null;
  const name = boundedText(body.name, 200);
  const address = boundedText(body.address, 500);
  const lat = coordinate(body.lat, 90);
  const lng = coordinate(body.lng, 180);
  const notes = body.accessNotes ?? "";
  const accessNotes = typeof notes === "string" ? notes.trim() || null : undefined;
  const kind = typeof body.kind === "string" && DESTINATION_KINDS.includes(body.kind) ? body.kind : null;
  if (!name || !address || lat === null || lng === null || !kind) return null;
  if (accessNotes === undefined || (accessNotes && accessNotes.length > 1000)) return null;
  return { name, kind, address, accessNotes, lat, lng };
}

class InvalidReferenceError extends Error {}

async function requireOffice(db: HealthDatabase, context: Context): Promise<AuthenticatedUser | Response> {
  const user = await currentUser(db, context);
  if (!user) return context.json({ error: "Authentication required" }, 401);
  if (!isOffice(user)) return context.json({ error: "Office role required" }, 403);
  return user;
}

function positiveInt(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseVehicle(body: unknown) {
  if (!isObject(body)) return null;
  const plateRaw = boundedText(body.plate, 32);
  const plate = plateRaw ? plateRaw.toUpperCase() : null;
  const model = boundedText(body.model, 200);
  const seats = positiveInt(body.seats);
  const front = body.front === undefined || body.front === 1 ? 1 : null;
  let featureIds: number[] | null = [];
  if (body.featureIds !== undefined) {
    if (!Array.isArray(body.featureIds)) return null;
    const ids: number[] = [];
    for (const item of body.featureIds) {
      const id = positiveInt(item);
      if (id === null) return null;
      ids.push(id);
    }
    featureIds = [...new Set(ids)].sort((a, b) => a - b);
  }
  if (!plate || !model || seats === null || front === null || featureIds === null) return null;
  return { plate, model, seats, front, featureIds };
}

const VEHICLE_SELECT_SQL = `
  SELECT
    v.id,
    v.plate,
    v.model,
    v.seats,
    v.front_seats AS front,
    v.deactivated_at AS "deactivatedAt",
    v.created_at AS "createdAt",
    COALESCE(
      array_agg(vf.id ORDER BY lower(vf.name), vf.id) FILTER (WHERE vf.id IS NOT NULL),
      '{}'::int[]
    ) AS "featureIds",
    COALESCE(
      array_agg(vf.name ORDER BY lower(vf.name), vf.id) FILTER (WHERE vf.id IS NOT NULL),
      '{}'::text[]
    ) AS features
  FROM vehicles v
  LEFT JOIN vehicle_feature_assignments vfa ON vfa.vehicle_id = v.id
  LEFT JOIN vehicle_features vf ON vf.id = vfa.feature_id
`;

function formatVehicleRow(row: Record<string, unknown>) {
  const seats = Number(row.seats);
  const front = Number(row.front);
  return {
    id: Number(row.id),
    plate: String(row.plate),
    model: String(row.model),
    seats,
    front,
    capacity: { seats, front },
    featureIds: (row.featureIds as number[]).map(Number),
    features: (row.features as string[]).map(String),
    deactivatedAt: (row.deactivatedAt as string | null) ?? null,
    createdAt: String(row.createdAt),
  };
}

async function syncVehicleFeatures(client: Queryable, vehicleId: number, featureIds: number[]) {
  await client.query("DELETE FROM vehicle_feature_assignments WHERE vehicle_id = $1", [vehicleId]);
  if (featureIds.length === 0) return;
  const existing = await client.query(
    "SELECT id FROM vehicle_features WHERE id = ANY($1::int[])",
    [featureIds],
  ) as QueryResult;
  if (existing.rows.length !== featureIds.length) throw new InvalidReferenceError("Unknown vehicle feature");
  await client.query(
    "INSERT INTO vehicle_feature_assignments (vehicle_id, feature_id) SELECT $1, unnest($2::int[])",
    [vehicleId, featureIds],
  );
}

async function getVehicleById(client: Queryable, vehicleId: number) {
  const result = await client.query(
    `${VEHICLE_SELECT_SQL} WHERE v.id = $1 GROUP BY v.id`,
    [vehicleId],
  ) as QueryResult;
  return result.rows[0] ? formatVehicleRow(result.rows[0]) : null;
}

const DRIVER_SELECT_SQL = `
  SELECT
    d.id,
    d.user_id AS "userId",
    u.username,
    d.name,
    d.home_address AS "homeAddress",
    d.home_latitude AS "homeLat",
    d.home_longitude AS "homeLng",
    d.usual_vehicle_id AS "usualVehicleId",
    v.plate AS "usualVehiclePlate",
    d.created_at AS "createdAt"
  FROM drivers d
  JOIN users u ON u.id = d.user_id
  LEFT JOIN vehicles v ON v.id = d.usual_vehicle_id AND v.deactivated_at IS NULL
`;

function parseDriverFields(body: unknown) {
  if (!isObject(body)) return null;
  const name = boundedText(body.name, 200);
  const homeAddress = boundedText(body.homeAddress, 500);
  const homeLat = coordinate(body.homeLat, 90);
  const homeLng = coordinate(body.homeLng, 180);
  if (!name || !homeAddress || homeLat === null || homeLng === null) return null;
  if (body.usualVehicleId === undefined || body.usualVehicleId === null) {
    return { name, homeAddress, homeLat, homeLng, usualVehicleId: null };
  }
  const usualVehicleId = positiveInt(body.usualVehicleId);
  if (usualVehicleId === null) return null;
  return { name, homeAddress, homeLat, homeLng, usualVehicleId };
}

function formatDriverRow(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    userId: Number(row.userId),
    username: String(row.username),
    name: String(row.name),
    homeAddress: String(row.homeAddress),
    homeLat: Number(row.homeLat),
    homeLng: Number(row.homeLng),
    usualVehicleId: row.usualVehicleId === null || row.usualVehicleId === undefined ? null : Number(row.usualVehicleId),
    usualVehiclePlate: row.usualVehiclePlate === null || row.usualVehiclePlate === undefined ? null : String(row.usualVehiclePlate),
    createdAt: String(row.createdAt),
  };
}

async function assertActiveUsualVehicle(client: Queryable, usualVehicleId: number | null) {
  if (usualVehicleId === null) return;
  const result = await client.query(
    "SELECT id, deactivated_at FROM vehicles WHERE id = $1 FOR UPDATE",
    [usualVehicleId],
  ) as QueryResult;
  const vehicle = result.rows[0] as { id: number; deactivated_at: string | null } | undefined;
  if (!vehicle || vehicle.deactivated_at !== null) throw new InvalidReferenceError("Invalid usual vehicle");
}

async function getDriverById(client: Queryable, driverId: number) {
  const result = await client.query(`${DRIVER_SELECT_SQL} WHERE d.id = $1`, [driverId]) as QueryResult;
  return result.rows[0] ? formatDriverRow(result.rows[0]) : null;

}

export function createApp({ db, routing, geocoder, config }: {
  db: HealthDatabase;
  routing: RoutingHealth;
  geocoder?: Geocoder;
  config: AppConfig;
}) {
  if (!config.serverEpoch.trim()) throw new Error("SERVER_EPOCH is required");
  const healthTimeoutMs = config.healthTimeoutMs ?? 1000;
  const now = config.now ?? Date.now;
  // One geocoder request per second for the whole process; cached answers do not use the slot.
  const geocodeCache = new Map<string, GeocodeResult | null>();
  let nextGeocodeAt = 0;
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
      const probes = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([db.query("SELECT 1"), routing.osrm(probes.signal), routing.vroom(probes.signal)]),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Health check timed out")), healthTimeoutMs);
          }),
        ]);
        return context.body(null, 200);
      } catch {
        return context.body(null, 503);
      } finally {
        if (timer) clearTimeout(timer);
        probes.abort();
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
      const reservation = reserveLoginAttempt(username, ip);
      if (!reservation) {
        context.header("Retry-After", String(Math.ceil(LOGIN_WINDOW_MS / 1000)));
        return context.json({ error: "Too many login attempts" }, 429);
      }

      let failedLogin = false;
      try {
        const accountResult = await db.query(
          "SELECT id, username, password_hash, role, disabled_at FROM users WHERE username = $1",
          [username],
        ) as QueryResult;
        const account = accountResult.rows[0] as UserRow | undefined;
        const verified = await verifyPassword(password, account?.password_hash ?? await dummyPasswordHash);
        if (!account || !verified || account.disabled_at) {
          failedLogin = true;
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
      } finally {
        finishLoginAttempt(reservation, failedLogin);
      }
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
    .get("/destinations", async (context) => {
      const user = await currentUser(db, context);
      if (!user) return context.json({ error: "Authentication required" }, 401);
      if (!isOffice(user)) return context.json({ error: "Office role required" }, 403);
      const result = await db.query(`SELECT ${DESTINATION_COLUMNS} FROM destinations ORDER BY name, id`) as QueryResult;
      return context.json({ destinations: result.rows });
    })
    .post("/destinations", async (context) => {
      const actor = await currentUser(db, context);
      if (!actor) return context.json({ error: "Authentication required" }, 401);
      if (!isOffice(actor)) return context.json({ error: "Office role required" }, 403);
      const destination = parseDestination(await context.req.json().catch(() => null));
      if (!destination) return context.json({ error: "Invalid request" }, 400);
      const created = await inTransaction(db, async (client) => {
        const result = await client.query(
          `INSERT INTO destinations (name, kind, address, access_notes, latitude, longitude) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${DESTINATION_COLUMNS}`,
          [destination.name, destination.kind, destination.address, destination.accessNotes, destination.lat, destination.lng],
        ) as QueryResult;
        const row = result.rows[0];
        await appendChange(client, actor.id, "destination", String(row.id), "created", null, destination);
        return row;
      });
      return context.json({ destination: created }, 201);
    })
    .get("/vehicle-features", async (context) => {
      const actor = await requireOffice(db, context);
      if (actor instanceof Response) return actor;
      const result = await db.query(
        `SELECT ${VEHICLE_FEATURE_COLUMNS} FROM vehicle_features ORDER BY lower(name), id`,
      ) as QueryResult;
      return context.json({ features: result.rows });
    })
    .post("/vehicle-features", async (context) => {
      const actor = await requireOffice(db, context);
      if (actor instanceof Response) return actor;
      const body = await context.req.json().catch(() => null);
      const name = isObject(body) ? boundedText(body.name, 200) : null;
      if (!name) return context.json({ error: "Invalid request" }, 400);
      try {
        const created = await inTransaction(db, async (client) => {
          const result = await client.query(
            `INSERT INTO vehicle_features (name) VALUES ($1) RETURNING ${VEHICLE_FEATURE_COLUMNS}`,
            [name],
          ) as QueryResult;
          const row = result.rows[0];
          await appendChange(client, actor.id, "vehicle_feature", String(row.id), "created", null, { name });
          return row;
        });
        return context.json({ feature: created }, 201);
      } catch (error) {
        if (isPostgresUniqueViolation(error)) return context.json({ error: "Vehicle feature already exists" }, 409);
        throw error;
      }
    })
    .patch("/vehicle-features/:id", async (context) => {
      const actor = await requireOffice(db, context);
      if (actor instanceof Response) return actor;
      const id = positiveInt(Number(context.req.param("id")));
      const body = await context.req.json().catch(() => null);
      const name = isObject(body) ? boundedText(body.name, 200) : null;
      if (!id || !name) return context.json({ error: "Invalid request" }, 400);
      try {
        const updated = await inTransaction(db, async (client) => {
          const existing = await client.query("SELECT id, name FROM vehicle_features WHERE id = $1 FOR UPDATE", [id]) as QueryResult;
          const before = existing.rows[0] as { id: number; name: string } | undefined;
          if (!before) return null;
          const result = await client.query(
            `UPDATE vehicle_features SET name = $1 WHERE id = $2 RETURNING ${VEHICLE_FEATURE_COLUMNS}`,
            [name, id],
          ) as QueryResult;
          await appendChange(client, actor.id, "vehicle_feature", String(id), "updated", { name: before.name }, { name });
          return result.rows[0];
        });
        return updated ? context.json({ feature: updated }) : context.json({ error: "Vehicle feature not found" }, 404);
      } catch (error) {
        if (isPostgresUniqueViolation(error)) return context.json({ error: "Vehicle feature already exists" }, 409);
        throw error;
      }
    })
    .get("/vehicles", async (context) => {
      const actor = await requireOffice(db, context);
      if (actor instanceof Response) return actor;
      const result = await db.query(
        `${VEHICLE_SELECT_SQL} GROUP BY v.id ORDER BY v.deactivated_at IS NOT NULL, v.plate, v.id`,
      ) as QueryResult;
      return context.json({ vehicles: result.rows.map(formatVehicleRow) });
    })
    .post("/vehicles", async (context) => {
      const actor = await requireOffice(db, context);
      if (actor instanceof Response) return actor;
      const vehicle = parseVehicle(await context.req.json().catch(() => null));
      if (!vehicle) return context.json({ error: "Invalid request" }, 400);
      try {
        const created = await inTransaction(db, async (client) => {
          const inserted = await client.query(
            "INSERT INTO vehicles (plate, model, seats, front_seats) VALUES ($1, $2, $3, $4) RETURNING id",
            [vehicle.plate, vehicle.model, vehicle.seats, vehicle.front],
          ) as QueryResult;
          const id = Number(inserted.rows[0].id);
          await syncVehicleFeatures(client, id, vehicle.featureIds);
          const loaded = (await getVehicleById(client, id))!;
          await appendChange(client, actor.id, "vehicle", String(id), "created", null, {
            plate: loaded.plate,
            model: loaded.model,
            seats: loaded.seats,
            front: loaded.front,
            featureIds: loaded.featureIds,
          });
          return loaded;
        });
        return context.json({ vehicle: created }, 201);
      } catch (error) {
        if (error instanceof InvalidReferenceError) return context.json({ error: "Invalid request" }, 400);
        if (isPostgresUniqueViolation(error)) return context.json({ error: "Active vehicle plate already exists" }, 409);
        throw error;
      }
    })
    .patch("/vehicles/:id", async (context) => {
      const actor = await requireOffice(db, context);
      if (actor instanceof Response) return actor;
      const id = positiveInt(Number(context.req.param("id")));
      const vehicle = parseVehicle(await context.req.json().catch(() => null));
      if (!id || !vehicle) return context.json({ error: "Invalid request" }, 400);
      try {
        const updated = await inTransaction(db, async (client) => {
          const lock = await client.query(
            "SELECT id, deactivated_at FROM vehicles WHERE id = $1 FOR UPDATE",
            [id],
          ) as QueryResult;
          const row = lock.rows[0] as { id: number; deactivated_at: string | null } | undefined;
          if (!row) return null;
          if (row.deactivated_at !== null) return "deactivated" as const;
          const before = (await getVehicleById(client, id))!;
          await client.query(
            "UPDATE vehicles SET plate = $1, model = $2, seats = $3, front_seats = $4 WHERE id = $5",
            [vehicle.plate, vehicle.model, vehicle.seats, vehicle.front, id],
          );
          await syncVehicleFeatures(client, id, vehicle.featureIds);
          const after = (await getVehicleById(client, id))!;
          await appendChange(client, actor.id, "vehicle", String(id), "updated", {
            plate: before.plate,
            model: before.model,
            seats: before.seats,
            front: before.front,
            featureIds: before.featureIds,
          }, {
            plate: after.plate,
            model: after.model,
            seats: after.seats,
            front: after.front,
            featureIds: after.featureIds,
          });
          return after;
        });
        if (!updated) return context.json({ error: "Vehicle not found" }, 404);
        if (updated === "deactivated") return context.json({ error: "Cannot edit a deactivated vehicle" }, 409);
        return context.json({ vehicle: updated });
      } catch (error) {
        if (error instanceof InvalidReferenceError) return context.json({ error: "Invalid request" }, 400);
        if (isPostgresUniqueViolation(error)) return context.json({ error: "Active vehicle plate already exists" }, 409);
        throw error;
      }
    })
    .patch("/vehicles/:id/deactivate", async (context) => {
      const actor = await requireOffice(db, context);
      if (actor instanceof Response) return actor;
      const id = positiveInt(Number(context.req.param("id")));
      if (!id) return context.json({ error: "Invalid request" }, 400);
      const deactivated = await inTransaction(db, async (client) => {
        const result = await client.query(
          "UPDATE vehicles SET deactivated_at = now() WHERE id = $1 AND deactivated_at IS NULL RETURNING id, plate",
          [id],
        ) as QueryResult;
        const previous = result.rows[0];
        if (!previous) return null;
        await appendChange(client, actor.id, "vehicle", String(id), "deactivated", { active: true }, {
          active: false,
          plate: previous.plate,
        });
        const affectedDrivers = await client.query(
          "SELECT id, name, home_address, home_latitude, home_longitude FROM drivers WHERE usual_vehicle_id = $1 FOR UPDATE",
          [id],
        ) as QueryResult;
        if (affectedDrivers.rows.length > 0) {
          await client.query("UPDATE drivers SET usual_vehicle_id = NULL WHERE usual_vehicle_id = $1", [id]);
          for (const d of affectedDrivers.rows) {
            const snap = {
              name: String(d.name),
              homeAddress: String(d.home_address),
              homeLat: Number(d.home_latitude),
              homeLng: Number(d.home_longitude),
            };
            await appendChange(client, actor.id, "driver", String(d.id), "updated",
              { ...snap, usualVehicleId: id },
              { ...snap, usualVehicleId: null });
          }
        }
        return previous;
      });
      if (!deactivated) {
        const existing = await db.query("SELECT id FROM vehicles WHERE id = $1", [id]) as QueryResult;
        return existing.rows.length ? context.body(null, 204) : context.json({ error: "Vehicle not found" }, 404);
      }
      return context.body(null, 204);
    })
    .get("/drivers", async (context) => {
      const actor = await requireOffice(db, context);
      if (actor instanceof Response) return actor;
      const result = await db.query(`${DRIVER_SELECT_SQL} ORDER BY lower(d.name), d.id`) as QueryResult;
      return context.json({ drivers: result.rows.map(formatDriverRow) });
    })
    .post("/drivers", async (context) => {
      const actor = await requireOffice(db, context);
      if (actor instanceof Response) return actor;
      const body = await context.req.json().catch(() => null);
      const fields = parseDriverFields(body);
      const userId = isObject(body) ? positiveInt(body.userId) : null;
      if (!fields || userId === null) return context.json({ error: "Invalid request" }, 400);
      try {
        const created = await inTransaction(db, async (client) => {
          const userRes = await client.query(
            "SELECT id, role, disabled_at FROM users WHERE id = $1 FOR UPDATE",
            [userId],
          ) as QueryResult;
          const targetUser = userRes.rows[0] as { id: number; role: string; disabled_at: string | null } | undefined;
          if (!targetUser || targetUser.role !== "driver" || targetUser.disabled_at !== null) {
            throw new InvalidReferenceError("Invalid driver user");
          }
          await assertActiveUsualVehicle(client, fields.usualVehicleId);
          const inserted = await client.query(
            `INSERT INTO drivers (user_id, name, home_address, home_latitude, home_longitude, usual_vehicle_id)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [userId, fields.name, fields.homeAddress, fields.homeLat, fields.homeLng, fields.usualVehicleId],
          ) as QueryResult;
          const id = Number(inserted.rows[0].id);
          const loaded = (await getDriverById(client, id))!;
          await appendChange(client, actor.id, "driver", String(id), "created", null, { userId, ...fields });
          return loaded;
        });
        return context.json({ driver: created }, 201);
      } catch (error) {
        if (error instanceof InvalidReferenceError) return context.json({ error: "Invalid request" }, 400);
        if (isPostgresUniqueViolation(error)) return context.json({ error: "User is already linked to a driver" }, 409);
        throw error;
      }
    })
    .patch("/drivers/:id", async (context) => {
      const actor = await requireOffice(db, context);
      if (actor instanceof Response) return actor;
      const id = positiveInt(Number(context.req.param("id")));
      const body = await context.req.json().catch(() => null);
      const fields = parseDriverFields(body);
      if (!id || !fields) return context.json({ error: "Invalid request" }, 400);
      if (isObject(body) && body.userId !== undefined && positiveInt(body.userId) === null) {
        return context.json({ error: "Invalid request" }, 400);
      }
      try {
        const updated = await inTransaction(db, async (client) => {
          const existing = await client.query("SELECT id, user_id FROM drivers WHERE id = $1 FOR UPDATE", [id]) as QueryResult;
          const row = existing.rows[0] as { id: number; user_id: number } | undefined;
          if (!row) return null;
          if (isObject(body) && body.userId !== undefined && body.userId !== Number(row.user_id)) {
            throw new InvalidReferenceError("Cannot relink driver user");
          }
          await assertActiveUsualVehicle(client, fields.usualVehicleId);
          const before = (await getDriverById(client, id))!;
          await client.query(
            `UPDATE drivers
                SET name = $1, home_address = $2, home_latitude = $3, home_longitude = $4, usual_vehicle_id = $5
              WHERE id = $6`,
            [fields.name, fields.homeAddress, fields.homeLat, fields.homeLng, fields.usualVehicleId, id],
          );
          const after = (await getDriverById(client, id))!;
          await appendChange(client, actor.id, "driver", String(id), "updated", {
            name: before.name,
            homeAddress: before.homeAddress,
            homeLat: before.homeLat,
            homeLng: before.homeLng,
            usualVehicleId: before.usualVehicleId,
          }, fields);
          return after;
        });
        return updated ? context.json({ driver: updated }) : context.json({ error: "Driver not found" }, 404);
      } catch (error) {
        if (error instanceof InvalidReferenceError) return context.json({ error: "Invalid request" }, 400);
        throw error;
      }
    })
    .post("/geocode", async (context) => {
      const user = await currentUser(db, context);
      if (!user) return context.json({ error: "Authentication required" }, 401);
      if (!isOffice(user)) return context.json({ error: "Office role required" }, 403);
      const body = await context.req.json().catch(() => null);
      const query = isObject(body) ? boundedText(body.query, 500) : null;
      if (!query) return context.json({ error: "Invalid request" }, 400);
      if (!geocoder) return context.json({ error: "Address search is turned off" }, 503);
      const key = query.toLowerCase();
      let result = geocodeCache.get(key);
      if (geocodeCache.has(key)) {
        geocodeCache.delete(key);
      } else {
        const startedAt = now();
        if (startedAt < nextGeocodeAt) {
          context.header("Retry-After", String(Math.ceil((nextGeocodeAt - startedAt) / 1000)));
          return context.json({ error: "Too many address searches" }, 429);
        }
        nextGeocodeAt = startedAt + GEOCODE_INTERVAL_MS;
        try {
          result = await geocoder(query);
        } catch {
          return context.json({ error: "Address search is unavailable" }, 502);
        }
        if (geocodeCache.size >= GEOCODE_CACHE_LIMIT) geocodeCache.delete(geocodeCache.keys().next().value!);
      }
      geocodeCache.set(key, result ?? null);
      if (!result) return context.json({ error: "No match for this address" }, 404);
      return context.json({ lat: result.lat, lng: result.lng, displayName: result.displayName });
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
