import { randomBytes } from "node:crypto";
import { getCookie, deleteCookie, setCookie } from "hono/cookie";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import type { ServerEpoch } from "@traslado/shared";
import { createSessionToken, hashPassword, hashSessionToken, normalizeUsername, verifyPassword } from "./auth.js";
import {
  createAttemptLimiter,
  matchTotpStep,
  REMEMBER_DEVICE_MS,
  SESSION_COLUMNS,
  sessionState,
  totpKeyUri,
  type SecondFactorStep,
  type SessionRow,
} from "./sessions.js";
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
  now?: () => Date;
};

type UserRow = {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  disabled_at: string | null;
  totp_confirmed_at: string | null;
};
type AuthenticatedUser = {
  id: number;
  username: string;
  role: string;
  session_id: number;
  pendingSecondFactor: SecondFactorStep | null;
};

const SESSION_COOKIE = "session";
const REMEMBER_COOKIE = "remember_device";
// Browsers cap cookie lifetime near 400 days; the server decides expiry (see sessions.ts).
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 400;
const COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: "Lax", path: "/" } as const;
const TOTP_FAILURE_LIMIT = 5;
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

function parseId(value: string) {
  const id = Number(value);
  return positiveInt(id);
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

function positiveInt(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647 ? value : null;
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

const MEDICAL_ALERT_MAX_LENGTH = 140;

function parseFeatureIds(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const ids: number[] = [];
  for (const item of value) {
    const id = positiveInt(item);
    if (id === null) return null;
    ids.push(id);
  }
  return [...new Set(ids)].sort((a, b) => a - b);
}

// Every field is required except access notes, the medical alert and Adaptaciones: the Oficina enters
// the minutes for each Pasajero, so the API never falls back to a constant (the form proposes defaults).
function parsePassenger(body: unknown) {
  if (!isObject(body)) return null;
  const name = boundedText(body.name, 200);
  const homeAddress = boundedText(body.homeAddress, 500);
  const homeLat = coordinate(body.homeLat, 90);
  const homeLng = coordinate(body.homeLng, 180);
  const notes = body.accessNotes ?? "";
  const accessNotes = typeof notes === "string" ? notes.trim() || null : undefined;
  const alert = body.medicalAlert ?? "";
  const medicalAlert = typeof alert === "string" ? alert.trim() || null : undefined;
  const companions = Number.isInteger(body.companions) && Number(body.companions) >= 0 && Number(body.companions) <= 2
    ? Number(body.companions)
    : null;
  const featureIds = parseFeatureIds(body.featureIds);
  const maxRideTimeMinutes = positiveInt(body.maxRideTimeMinutes);
  const pickupDurationMinutes = positiveInt(body.pickupDurationMinutes);
  const dropoffDurationMinutes = positiveInt(body.dropoffDurationMinutes);
  if (!name || !homeAddress || homeLat === null || homeLng === null || companions === null || featureIds === null) return null;
  if (typeof body.frontSeat !== "boolean" || typeof body.wheelchair !== "boolean") return null;
  if (maxRideTimeMinutes === null || pickupDurationMinutes === null || dropoffDurationMinutes === null) return null;
  if (accessNotes === undefined || (accessNotes && accessNotes.length > 1000)) return null;
  // Counted in code points, as PostgreSQL's char_length does.
  if (medicalAlert === undefined || (medicalAlert && [...medicalAlert].length > MEDICAL_ALERT_MAX_LENGTH)) return null;
  return {
    name,
    homeAddress,
    homeLat,
    homeLng,
    accessNotes,
    companions,
    frontSeat: body.frontSeat,
    wheelchair: body.wheelchair,
    featureIds,
    maxRideTimeMinutes,
    pickupDurationMinutes,
    dropoffDurationMinutes,
    medicalAlert,
  };
}

type PassengerFields = NonNullable<ReturnType<typeof parsePassenger>>;

const PASSENGER_SELECT_SQL = `
  SELECT
    p.id,
    p.name,
    p.home_address AS "homeAddress",
    p.home_latitude AS "homeLat",
    p.home_longitude AS "homeLng",
    p.access_notes AS "accessNotes",
    p.companions,
    p.front_seat AS "frontSeat",
    p.wheelchair,
    p.max_ride_time_minutes AS "maxRideTimeMinutes",
    p.pickup_duration_minutes AS "pickupDurationMinutes",
    p.dropoff_duration_minutes AS "dropoffDurationMinutes",
    p.medical_alert AS "medicalAlert",
    p.deactivated_at AS "deactivatedAt",
    p.created_at AS "createdAt",
    COALESCE(
      array_agg(vf.id ORDER BY lower(vf.name), vf.id) FILTER (WHERE vf.id IS NOT NULL),
      '{}'::int[]
    ) AS "featureIds",
    COALESCE(
      array_agg(vf.name ORDER BY lower(vf.name), vf.id) FILTER (WHERE vf.id IS NOT NULL),
      '{}'::text[]
    ) AS features
  FROM passengers p
  LEFT JOIN passenger_required_features prf ON prf.passenger_id = p.id
  LEFT JOIN vehicle_features vf ON vf.id = prf.feature_id
`;

function formatPassengerRow(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    name: String(row.name),
    homeAddress: String(row.homeAddress),
    homeLat: Number(row.homeLat),
    homeLng: Number(row.homeLng),
    accessNotes: (row.accessNotes as string | null) ?? null,
    companions: Number(row.companions),
    frontSeat: Boolean(row.frontSeat),
    wheelchair: Boolean(row.wheelchair),
    featureIds: (row.featureIds as number[]).map(Number),
    features: (row.features as string[]).map(String),
    maxRideTimeMinutes: Number(row.maxRideTimeMinutes),
    pickupDurationMinutes: Number(row.pickupDurationMinutes),
    dropoffDurationMinutes: Number(row.dropoffDurationMinutes),
    medicalAlert: (row.medicalAlert as string | null) ?? null,
    deactivatedAt: (row.deactivatedAt as string | null) ?? null,
    createdAt: String(row.createdAt),
  };
}

// The logged fields of a Pasajero, from a parsed request or a stored row, with Adaptaciones in id order on both sides.
function passengerSnapshot(passenger: PassengerFields): PassengerFields {
  return {
    name: passenger.name,
    homeAddress: passenger.homeAddress,
    homeLat: passenger.homeLat,
    homeLng: passenger.homeLng,
    accessNotes: passenger.accessNotes,
    companions: passenger.companions,
    frontSeat: passenger.frontSeat,
    wheelchair: passenger.wheelchair,
    featureIds: [...passenger.featureIds].sort((a, b) => a - b),
    maxRideTimeMinutes: passenger.maxRideTimeMinutes,
    pickupDurationMinutes: passenger.pickupDurationMinutes,
    dropoffDurationMinutes: passenger.dropoffDurationMinutes,
    medicalAlert: passenger.medicalAlert,
  };
}

async function syncPassengerFeatures(client: Queryable, passengerId: number, featureIds: number[]) {
  await client.query("DELETE FROM passenger_required_features WHERE passenger_id = $1", [passengerId]);
  if (featureIds.length === 0) return;
  const existing = await client.query(
    "SELECT id FROM vehicle_features WHERE id = ANY($1::int[])",
    [featureIds],
  ) as QueryResult;
  if (existing.rows.length !== featureIds.length) throw new InvalidReferenceError("Unknown vehicle feature");
  await client.query(
    "INSERT INTO passenger_required_features (passenger_id, feature_id) SELECT $1, unnest($2::int[])",
    [passengerId, featureIds],
  );
}

async function getPassengerById(client: Queryable, passengerId: number) {
  const result = await client.query(
    `${PASSENGER_SELECT_SQL} WHERE p.id = $1 GROUP BY p.id`,
    [passengerId],
  ) as QueryResult;
  return result.rows[0] ? formatPassengerRow(result.rows[0]) : null;
}

export function createApp({ db, routing, geocoder, config }: {
  db: HealthDatabase;
  routing: RoutingHealth;
  geocoder?: Geocoder;
  config: AppConfig;
}) {
  if (!config.serverEpoch.trim()) throw new Error("SERVER_EPOCH is required");
  const healthTimeoutMs = config.healthTimeoutMs ?? 1000;
  const now = config.now ?? (() => new Date());
  // One geocoder request per second for the whole process; cached answers do not use the slot.
  const geocodeCache = new Map<string, GeocodeResult | null>();
  let nextGeocodeAt = 0;
  const totpLimiter = createAttemptLimiter(TOTP_FAILURE_LIMIT, LOGIN_WINDOW_MS, now);

  function setSessionCookie(context: Context, token: string) {
    setCookie(context, SESSION_COOKIE, token, { ...COOKIE_OPTIONS, maxAge: SESSION_MAX_AGE_SECONDS });
  }

  /** Resolves the session cookie; a pending second factor is accepted only where `allowPending` is set. */
  async function authenticate(context: Context, allowPending = false): Promise<AuthenticatedUser | Response> {
    const token = getCookie(context, SESSION_COOKIE);
    if (!token) return context.json({ error: "Authentication required" }, 401);
    const result = await db.query(
      `SELECT ${SESSION_COLUMNS} FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1`,
      [hashSessionToken(token)],
    ) as QueryResult;
    const row = result.rows[0] as SessionRow | undefined;
    if (!row) return context.json({ error: "Authentication required", code: "session_expired" }, 401);
    const current = now();
    const state = sessionState(row, current);
    if (state.kind === "ended") return context.json({ error: "Authentication required", code: state.code }, 401);
    if (state.kind === "pending" && !allowPending) {
      return context.json({ error: "Authentication required", code: "second_factor_required" }, 401);
    }
    await db.query(
      "UPDATE sessions SET last_used_at = $2 WHERE id = $1 AND last_used_at <= $2::timestamptz - interval '1 minute'",
      [row.session_id, current],
    );
    setSessionCookie(context, token);
    return {
      id: row.user_id,
      username: row.username,
      role: row.role,
      session_id: row.session_id,
      pendingSecondFactor: state.kind === "pending" ? state.secondFactor : null,
    };
  }

  async function requireOffice(context: Context) {
    const user = await authenticate(context);
    if (user instanceof Response || isOffice(user)) return user;
    return context.json({ error: "Office role required" }, 403);
  }

  // Only deactivated_at changes, so every other field of the Pasajero is kept. A repeated call is a no-op without a log entry.
  async function setPassengerActive(context: Context, actorId: number, id: number, active: boolean) {
    const changed = await inTransaction(db, async (client) => {
      const result = await client.query(
        active
          ? "UPDATE passengers SET deactivated_at = NULL WHERE id = $1 AND deactivated_at IS NOT NULL RETURNING name"
          : "UPDATE passengers SET deactivated_at = now() WHERE id = $1 AND deactivated_at IS NULL RETURNING name",
        [id],
      ) as QueryResult;
      const row = result.rows[0];
      if (!row) return false;
      await appendChange(client, actorId, "passenger", String(id), active ? "reactivated" : "deactivated", { active: !active }, {
        active,
        name: row.name,
      });
      return true;
    });
    if (changed) return context.body(null, 204);
    const existing = await db.query("SELECT id FROM passengers WHERE id = $1", [id]) as QueryResult;
    return existing.rows.length ? context.body(null, 204) : context.json({ error: "Passenger not found" }, 404);
  }

  async function listSessions(userId: number) {
    const result = await db.query(
      `SELECT ${SESSION_COLUMNS} FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.user_id = $1 AND s.revoked_at IS NULL ORDER BY s.created_at DESC, s.id DESC`,
      [userId],
    ) as QueryResult;
    const current = now();
    return (result.rows as SessionRow[]).filter((row) => sessionState(row, current).kind !== "ended");
  }
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
        context.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
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
          "SELECT id, username, password_hash, role, disabled_at, totp_confirmed_at FROM users WHERE username = $1",
          [username],
        ) as QueryResult;
        const account = accountResult.rows[0] as UserRow | undefined;
        const verified = await verifyPassword(password, account?.password_hash ?? await dummyPasswordHash);
        if (!account || !verified || account.disabled_at) {
          failedLogin = true;
          return invalidCredentials(context);
        }

        const token = createSessionToken();
        const rememberToken = account.role === "office" ? getCookie(context, REMEMBER_COOKIE) : undefined;
        const current = now();
        const created = await inTransaction(db, async (client) => {
          // The password was checked before this transaction; a reset or disable that committed since then wins.
          const locked = await client.query(
            "SELECT password_hash, disabled_at, totp_confirmed_at FROM users WHERE id = $1 FOR UPDATE",
            [account.id],
          ) as QueryResult;
          const still = locked.rows[0] as Pick<UserRow, "password_hash" | "disabled_at" | "totp_confirmed_at"> | undefined;
          if (!still || still.password_hash !== account.password_hash || still.disabled_at) return null;
          const inserted = await client.query(
            "INSERT INTO sessions (user_id, token_hash, device_label, created_at, last_used_at) VALUES ($1, $2, $3, $4, $4) RETURNING id",
            [account.id, hashSessionToken(token), deviceLabel, current],
          ) as QueryResult;
          const id = Number(inserted.rows[0]?.id);
          // A remembered device skips the second factor and is re-bound to the new session it now belongs to.
          const rebound = rememberToken ? await client.query(
            "UPDATE remembered_devices SET session_id = $1 WHERE token_hash = $2 AND user_id = $3 AND expires_at > $4 RETURNING id",
            [id, hashSessionToken(rememberToken), account.id, current],
          ) as QueryResult : null;
          if (rebound?.rowCount) await client.query("UPDATE sessions SET second_factor_at = $2 WHERE id = $1", [id, current]);
          await appendChange(client, account.id, "session", String(id), "created", null, { deviceLabel });
          return { sessionId: id, remembered: Boolean(rebound?.rowCount), totpConfirmed: Boolean(still.totp_confirmed_at) };
        });
        if (!created) return invalidCredentials(context);
        const { sessionId, remembered, totpConfirmed } = created;
        setSessionCookie(context, token);
        const user = { id: account.id, username: account.username, role: account.role };
        if (account.role !== "office" || remembered) return context.json({ user, sessionId });
        const secondFactor: SecondFactorStep = totpConfirmed ? "code_required" : "enrolment_required";
        return context.json({ user, sessionId, secondFactor });
      } finally {
        finishLoginAttempt(reservation, failedLogin);
      }
    })
    .post("/auth/totp/enrol", async (context) => {
      const user = await authenticate(context, true);
      if (user instanceof Response) return user;
      if (!isOffice(user)) return context.json({ error: "Office role required" }, 403);
      const key = randomBytes(20);
      const updated = await db.query(
        "UPDATE users SET totp_secret = $1, totp_last_step = NULL WHERE id = $2 AND totp_confirmed_at IS NULL",
        [Buffer.from(key).toString("base64url"), user.id],
      ) as QueryResult;
      if (!updated.rowCount) return context.json({ error: "Two-factor authentication is already set up" }, 409);
      return context.json(totpKeyUri(user.username, key));
    })
    .post("/auth/totp/verify", async (context) => {
      const user = await authenticate(context, true);
      if (user instanceof Response) return user;
      if (!isOffice(user)) return context.json({ error: "Office role required" }, 403);
      if (!user.pendingSecondFactor) return context.json({ error: "Second factor already verified" }, 409);
      const body = await context.req.json().catch(() => null);
      if (!isObject(body) || typeof body.code !== "string" || (body.rememberDevice !== undefined && typeof body.rememberDevice !== "boolean")) {
        return context.json({ error: "Invalid request" }, 400);
      }
      const limiterKey = `user:${user.id}`;
      if (!totpLimiter.reserve(limiterKey)) {
        context.header("Retry-After", String(totpLimiter.retryAfterSeconds));
        return context.json({ error: "Too many code attempts" }, 429);
      }
      let failed = true;
      try {
        const current = now();
        const rememberToken = body.rememberDevice ? createSessionToken() : null;
        const accepted = await inTransaction(db, async (client) => {
          const result = await client.query(
            "SELECT totp_secret, totp_confirmed_at, totp_last_step FROM users WHERE id = $1 FOR UPDATE",
            [user.id],
          ) as QueryResult;
          const account = result.rows[0] as { totp_secret: string | null; totp_confirmed_at: Date | null; totp_last_step: number | null } | undefined;
          if (!account?.totp_secret) return false;
          const step = matchTotpStep(Buffer.from(account.totp_secret, "base64url"), String(body.code).trim(), current);
          // Each step is accepted once: the row lock makes concurrent requests with the same code see the stored step.
          if (step === null || (account.totp_last_step !== null && step <= account.totp_last_step)) return false;
          await client.query(
            "UPDATE users SET totp_last_step = $2, totp_confirmed_at = COALESCE(totp_confirmed_at, $3) WHERE id = $1",
            [user.id, step, current],
          );
          await client.query("UPDATE sessions SET second_factor_at = $2 WHERE id = $1", [user.session_id, current]);
          if (!account.totp_confirmed_at) await appendChange(client, user.id, "user", String(user.id), "totp_enrolled", null, { totpEnrolled: true });
          if (rememberToken) {
            await client.query(
              "INSERT INTO remembered_devices (user_id, session_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)",
              [user.id, user.session_id, hashSessionToken(rememberToken), new Date(current.getTime() + REMEMBER_DEVICE_MS)],
            );
          }
          return true;
        });
        if (!accepted) return context.json({ error: "Invalid code" }, 400);
        failed = false;
        if (rememberToken) setCookie(context, REMEMBER_COOKIE, rememberToken, { ...COOKIE_OPTIONS, maxAge: REMEMBER_DEVICE_MS / 1000 });
        return context.body(null, 204);
      } finally {
        totpLimiter.finish(limiterKey, failed);
      }
    })
    .get("/auth/me", async (context) => {
      const user = await authenticate(context, true);
      if (user instanceof Response) return user;
      const body = { user: { id: user.id, username: user.username, role: user.role } };
      return context.json(user.pendingSecondFactor ? { ...body, secondFactor: user.pendingSecondFactor } : body);
    })
    .get("/auth/sessions", async (context) => {
      const user = await authenticate(context);
      if (user instanceof Response) return user;
      const sessions = await listSessions(user.id);
      return context.json({ sessions: sessions.map((row) => ({ id: row.session_id, device_label: row.device_label, created_at: row.created_at })) });
    })
    .post("/auth/logout", async (context) => {
      const token = getCookie(context, SESSION_COOKIE);
      if (token) {
        await inTransaction(db, async (client) => {
          const ended = await client.query(
            "UPDATE sessions SET revoked_at = $2, ended_reason = 'logout' WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id, user_id",
            [hashSessionToken(token), now()],
          ) as QueryResult;
          const session = ended.rows[0];
          if (session) await appendChange(client, Number(session.user_id), "session", String(session.id), "revoked", { active: true }, { active: false });
        });
      }
      deleteCookie(context, SESSION_COOKIE, { path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
      return context.body(null, 204);
    })
    .get("/users", async (context) => {
      const user = await requireOffice(context);
      if (user instanceof Response) return user;
      const result = await db.query(
        "SELECT id, username, role, disabled_at, created_at, persistent_session FROM users ORDER BY username",
      ) as QueryResult;
      return context.json({ users: result.rows });
    })
    .post("/users", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
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
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
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
        await client.query(
          "UPDATE users SET password_hash = $1, totp_secret = NULL, totp_confirmed_at = NULL, totp_last_step = NULL WHERE id = $2",
          [passwordHash, id],
        );
        await client.query(
          "UPDATE sessions SET revoked_at = $2, ended_reason = 'password_reset' WHERE user_id = $1 AND revoked_at IS NULL",
          [id, now()],
        );
        await client.query("DELETE FROM remembered_devices WHERE user_id = $1", [id]);
        await appendChange(client, actor.id, "user", String(id), "password_reset", null, { username: before.username, totpReset: before.role === "office" });
        return true;
      });
      return updated ? context.body(null, 204) : context.json({ error: "User not found" }, 404);
    })
    .patch("/users/:id/disable", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const id = Number(context.req.param("id"));
      if (!Number.isSafeInteger(id) || id <= 0) return context.json({ error: "Invalid request" }, 400);
      const outcome = await inTransaction(db, async (client) => {
        // Locking every active Oficina row serializes concurrent disables: the later one sees a single active account.
        const activeOffice = await client.query(
          "SELECT id FROM users WHERE role = 'office' AND disabled_at IS NULL ORDER BY id FOR UPDATE",
        ) as QueryResult;
        const result = await client.query("SELECT id, username, role, disabled_at FROM users WHERE id = $1 FOR UPDATE", [id]) as QueryResult;
        const previous = result.rows[0];
        if (!previous) return "missing";
        if (previous.disabled_at) return "unchanged";
        if (previous.role === "office" && activeOffice.rows.length <= 1) return "last-office";
        const current = now();
        await client.query("UPDATE users SET disabled_at = $2 WHERE id = $1", [id, current]);
        await client.query(
          "UPDATE sessions SET revoked_at = $2, ended_reason = 'account_disabled' WHERE user_id = $1 AND revoked_at IS NULL",
          [id, current],
        );
        await appendChange(client, actor.id, "user", String(id), "disabled", { disabled: false }, { disabled: true, username: previous.username, role: previous.role });
        return "disabled";
      });
      if (outcome === "missing") return context.json({ error: "User not found" }, 404);
      if (outcome === "last-office") return context.json({ error: "The last active Oficina account cannot be disabled" }, 409);
      return context.body(null, 204);
    })
    .patch("/users/:id/persistent-session", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const id = parseId(context.req.param("id"));
      const body = await context.req.json().catch(() => null);
      if (!id || !isObject(body) || typeof body.persistent !== "boolean") return context.json({ error: "Invalid request" }, 400);
      const persistent = body.persistent;
      const outcome = await inTransaction(db, async (client) => {
        const result = await client.query("SELECT role, persistent_session FROM users WHERE id = $1 FOR UPDATE", [id]) as QueryResult;
        const target = result.rows[0];
        if (!target) return "missing";
        if (target.role !== "office") return "not-office";
        if (target.persistent_session === persistent) return "unchanged";
        await client.query("UPDATE users SET persistent_session = $2 WHERE id = $1", [id, persistent]);
        await appendChange(client, actor.id, "user", String(id), "persistent_session_changed", { persistentSession: !persistent }, { persistentSession: persistent });
        return "changed";
      });
      if (outcome === "missing") return context.json({ error: "User not found" }, 404);
      if (outcome === "not-office") return context.json({ error: "Persistent sessions exist for Oficina accounts only" }, 400);
      return context.body(null, 204);
    })
    .get("/users/:id/sessions", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const id = parseId(context.req.param("id"));
      if (!id) return context.json({ error: "Invalid request" }, 400);
      const exists = await db.query("SELECT id FROM users WHERE id = $1", [id]) as QueryResult;
      if (!exists.rows.length) return context.json({ error: "User not found" }, 404);
      const sessions = await listSessions(id);
      return context.json({
        sessions: sessions.map((row) => ({
          id: row.session_id,
          device_label: row.device_label,
          created_at: row.created_at,
          last_used_at: row.last_used_at,
          current: row.session_id === actor.session_id,
        })),
      });
    })
    .delete("/users/:id/sessions/:sessionId", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const id = parseId(context.req.param("id"));
      const sessionId = parseId(context.req.param("sessionId"));
      if (!id || !sessionId) return context.json({ error: "Invalid request" }, 400);
      const found = await inTransaction(db, async (client) => {
        const result = await client.query(
          "SELECT device_label, revoked_at FROM sessions WHERE id = $1 AND user_id = $2 FOR UPDATE",
          [sessionId, id],
        ) as QueryResult;
        const session = result.rows[0];
        if (!session) return false;
        await client.query("DELETE FROM remembered_devices WHERE session_id = $1", [sessionId]);
        if (session.revoked_at) return true;
        await client.query("UPDATE sessions SET revoked_at = $2, ended_reason = 'device_revoked' WHERE id = $1", [sessionId, now()]);
        await appendChange(client, actor.id, "session", String(sessionId), "device_revoked", { active: true }, {
          active: false,
          userId: id,
          deviceLabel: session.device_label,
        });
        return true;
      });
      return found ? context.body(null, 204) : context.json({ error: "Session not found" }, 404);
    })
    .get("/destinations", async (context) => {
      const user = await requireOffice(context);
      if (user instanceof Response) return user;
      const result = await db.query(`SELECT ${DESTINATION_COLUMNS} FROM destinations ORDER BY name, id`) as QueryResult;
      return context.json({ destinations: result.rows });
    })
    .post("/destinations", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
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
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const result = await db.query(
        `SELECT ${VEHICLE_FEATURE_COLUMNS} FROM vehicle_features ORDER BY lower(name), id`,
      ) as QueryResult;
      return context.json({ features: result.rows });
    })
    .post("/vehicle-features", async (context) => {
      const actor = await requireOffice(context);
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
      const actor = await requireOffice(context);
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
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const result = await db.query(
        `${VEHICLE_SELECT_SQL} GROUP BY v.id ORDER BY v.deactivated_at IS NOT NULL, v.plate, v.id`,
      ) as QueryResult;
      return context.json({ vehicles: result.rows.map(formatVehicleRow) });
    })
    .post("/vehicles", async (context) => {
      const actor = await requireOffice(context);
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
      const actor = await requireOffice(context);
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
      const actor = await requireOffice(context);
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
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const result = await db.query(`${DRIVER_SELECT_SQL} ORDER BY lower(d.name), d.id`) as QueryResult;
      return context.json({ drivers: result.rows.map(formatDriverRow) });
    })
    .post("/drivers", async (context) => {
      const actor = await requireOffice(context);
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
      const actor = await requireOffice(context);
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
    .get("/passengers", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const result = await db.query(
        `${PASSENGER_SELECT_SQL} GROUP BY p.id ORDER BY p.deactivated_at IS NOT NULL, lower(p.name), p.id`,
      ) as QueryResult;
      return context.json({ passengers: result.rows.map(formatPassengerRow) });
    })
    .post("/passengers", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const passenger = parsePassenger(await context.req.json().catch(() => null));
      if (!passenger) return context.json({ error: "Invalid request" }, 400);
      try {
        const created = await inTransaction(db, async (client) => {
          const inserted = await client.query(
            `INSERT INTO passengers (name, home_address, home_latitude, home_longitude, access_notes, companions, front_seat,
               wheelchair, max_ride_time_minutes, pickup_duration_minutes, dropoff_duration_minutes, medical_alert)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
            [passenger.name, passenger.homeAddress, passenger.homeLat, passenger.homeLng, passenger.accessNotes, passenger.companions,
              passenger.frontSeat, passenger.wheelchair, passenger.maxRideTimeMinutes, passenger.pickupDurationMinutes,
              passenger.dropoffDurationMinutes, passenger.medicalAlert],
          ) as QueryResult;
          const id = Number(inserted.rows[0].id);
          await syncPassengerFeatures(client, id, passenger.featureIds);
          await appendChange(client, actor.id, "passenger", String(id), "created", null, passengerSnapshot(passenger));
          return (await getPassengerById(client, id))!;
        });
        return context.json({ passenger: created }, 201);
      } catch (error) {
        if (error instanceof InvalidReferenceError) return context.json({ error: "Invalid request" }, 400);
        throw error;
      }
    })
    .patch("/passengers/:id", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const id = parseId(context.req.param("id"));
      const passenger = parsePassenger(await context.req.json().catch(() => null));
      if (!id || !passenger) return context.json({ error: "Invalid request" }, 400);
      try {
        const updated = await inTransaction(db, async (client) => {
          const lock = await client.query("SELECT deactivated_at FROM passengers WHERE id = $1 FOR UPDATE", [id]) as QueryResult;
          const row = lock.rows[0] as { deactivated_at: string | null } | undefined;
          if (!row) return null;
          if (row.deactivated_at !== null) return "deactivated" as const;
          const before = (await getPassengerById(client, id))!;
          await client.query(
            `UPDATE passengers
                SET name = $1, home_address = $2, home_latitude = $3, home_longitude = $4, access_notes = $5, companions = $6,
                    front_seat = $7, wheelchair = $8, max_ride_time_minutes = $9, pickup_duration_minutes = $10,
                    dropoff_duration_minutes = $11, medical_alert = $12
              WHERE id = $13`,
            [passenger.name, passenger.homeAddress, passenger.homeLat, passenger.homeLng, passenger.accessNotes, passenger.companions,
              passenger.frontSeat, passenger.wheelchair, passenger.maxRideTimeMinutes, passenger.pickupDurationMinutes,
              passenger.dropoffDurationMinutes, passenger.medicalAlert, id],
          );
          await syncPassengerFeatures(client, id, passenger.featureIds);
          await appendChange(client, actor.id, "passenger", String(id), "updated", passengerSnapshot(before), passengerSnapshot(passenger));
          return (await getPassengerById(client, id))!;
        });
        if (!updated) return context.json({ error: "Passenger not found" }, 404);
        if (updated === "deactivated") return context.json({ error: "Cannot edit a deactivated passenger" }, 409);
        return context.json({ passenger: updated });
      } catch (error) {
        if (error instanceof InvalidReferenceError) return context.json({ error: "Invalid request" }, 400);
        throw error;
      }
    })
    .patch("/passengers/:id/deactivate", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const id = parseId(context.req.param("id"));
      if (!id) return context.json({ error: "Invalid request" }, 400);
      return await setPassengerActive(context, actor.id, id, false);
    })
    .patch("/passengers/:id/reactivate", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const id = parseId(context.req.param("id"));
      if (!id) return context.json({ error: "Invalid request" }, 400);
      return await setPassengerActive(context, actor.id, id, true);
    })
    .post("/geocode", async (context) => {
      const user = await requireOffice(context);
      if (user instanceof Response) return user;
      const body = await context.req.json().catch(() => null);
      const query = isObject(body) ? boundedText(body.query, 500) : null;
      if (!query) return context.json({ error: "Invalid request" }, 400);
      if (!geocoder) return context.json({ error: "Address search is turned off" }, 503);
      const key = query.toLowerCase();
      let result = geocodeCache.get(key);
      if (geocodeCache.has(key)) {
        geocodeCache.delete(key);
      } else {
        const startedAt = now().getTime();
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
