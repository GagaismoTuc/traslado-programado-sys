import { createHash, randomBytes } from "node:crypto";
import { getCookie, deleteCookie, setCookie } from "hono/cookie";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { validateRoute, type RouteViolation, type ServerEpoch, type Stop as ValidatorStop } from "@traslado/shared";
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
import type { TravelTime } from "./routing.js";
import { planRoute, speedFactorAt, type LngLat, type PlannerSettings, type PlanResult, type PlanTransfer, type VroomSolver } from "./planner.js";

type QueryResult = { rows: Record<string, unknown>[]; rowCount: number | null };
type Queryable = { query: (sql: string, values?: unknown[]) => Promise<unknown> };
type DatabaseClient = Queryable & { release: () => void };

export type HealthDatabase = Queryable & { connect?: () => Promise<DatabaseClient> };

export type HealthProbe = (signal: AbortSignal) => Promise<unknown>;

export type RoutingHealth = {
  osrm: HealthProbe;
  vroom: HealthProbe;
};

export type RouteLeg = { distanceMeters: number; durationSeconds: number };
/** Road legs between consecutive points, in order: n points give n - 1 legs. */
export type Router = (points: { lat: number; lng: number }[]) => Promise<RouteLeg[]>;

export type AppConfig = {
  serverEpoch: ServerEpoch;
  healthTimeoutMs?: number;
  trustedOrigins?: string[];
  getClientIp?: (context: Context) => string;
  now?: () => Date;
  // A Chofer's day is cut into Recorridos where two consecutive target times are further apart than this.
  routeGapMinutes?: number;
  planner?: PlannerSettings;
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
const DESTINATION_COLUMNS = `id, name, kind, address, access_notes AS "accessNotes", latitude AS lat, longitude AS lng,
  arrival_tolerance_minutes AS "arrivalToleranceMinutes", created_at AS "createdAt"`;
// Tolerancia de llegada by kind when the Oficina does not give one: schools and day centres half an hour, the rest none.
const DEFAULT_ARRIVAL_TOLERANCE: Record<string, number> = { school: 30, day_centre: 30 };
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
  const arrivalToleranceMinutes = body.arrivalToleranceMinutes === undefined || body.arrivalToleranceMinutes === null
    ? DEFAULT_ARRIVAL_TOLERANCE[kind] ?? 0
    : parseArrivalTolerance(body.arrivalToleranceMinutes);
  if (arrivalToleranceMinutes === null) return null;
  return { name, kind, address, accessNotes, lat, lng, arrivalToleranceMinutes };
}

function parseArrivalTolerance(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 240 ? value : null;
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

function parseAuthorizedAdult(body: unknown) {
  if (!isObject(body)) return null;
  const name = boundedText(body.name, 200);
  const dni = boundedText(body.dni, 20);
  const relation = boundedText(body.relation, 100);
  const phone = boundedText(body.phone, 50);
  if (!name || !dni || !relation || !phone || typeof body.legalGuardian !== "boolean") return null;
  return { name, dni, relation, phone, legalGuardian: body.legalGuardian };
}

const AUTHORIZED_ADULT_SELECT_SQL = `
  SELECT id, passenger_id AS "passengerId", name, dni, relation, phone, legal_guardian AS "legalGuardian" FROM authorized_adults
`;

function formatAuthorizedAdult(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    passengerId: Number(row.passengerId),
    name: String(row.name),
    dni: String(row.dni),
    relation: String(row.relation),
    phone: String(row.phone),
    legalGuardian: Boolean(row.legalGuardian),
  };
}

const SIGNER_MUST_STAY = "This Adulto autorizado signed the Consentimiento: record it with another Responsable legal first";

async function signedConsent(client: Queryable, adultId: number) {
  const result = await client.query("SELECT 1 FROM consents WHERE signed_by_adult_id = $1", [adultId]) as QueryResult;
  return result.rows.length > 0;
}

function parseConsent(body: unknown) {
  if (!isObject(body)) return null;
  const signedByAdultId = positiveInt(body.signedByAdultId);
  const signedAt = parsePlanDate(body.signedAt);
  if (!signedByAdultId || !signedAt || typeof body.otherAdultAllowed !== "boolean") return null;
  return { signedByAdultId, signedAt, otherAdultAllowed: body.otherAdultAllowed };
}

async function getConsent(client: Queryable, passengerId: number) {
  const result = await client.query(
    `SELECT c.signed_by_adult_id AS "signedByAdultId", a.name AS "signedByName", to_char(c.signed_at, 'YYYY-MM-DD') AS "signedAt",
            c.other_adult_allowed AS "otherAdultAllowed"
       FROM consents c JOIN authorized_adults a ON a.id = c.signed_by_adult_id
      WHERE c.passenger_id = $1`,
    [passengerId],
  ) as QueryResult;
  const row = result.rows[0];
  if (!row) return null;
  return {
    signedByAdultId: Number(row.signedByAdultId),
    signedByName: String(row.signedByName),
    signedAt: String(row.signedAt),
    otherAdultAllowed: Boolean(row.otherAdultAllowed),
  };
}

/** A planning write refused with its HTTP status; thrown inside a transaction so nothing is kept. */
class PlanningError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 502, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

function planningFailure(context: Context, error: unknown) {
  if (error instanceof PlanningError) return context.json({ error: error.message, ...error.extra }, error.status);
  if (error instanceof InvalidReferenceError) return context.json({ error: "Invalid request" }, 400);
  throw error;
}

function parsePlanDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

// Local wall-clock time of the Plan diario's zone, "HH:MM".
function parseLocalTime(value: unknown) {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : null;
}

function minutesOf(time: string) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function parseCompanions(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2 ? value : null;
}

// The Acompañantes default from the Pasajero when the request leaves them out.
function parseTransfer(body: unknown) {
  if (!isObject(body)) return null;
  const passengerId = positiveInt(body.passengerId);
  const destinationId = positiveInt(body.destinationId);
  const direction = body.direction === "entrada" || body.direction === "salida" ? body.direction : null;
  const targetTime = parseLocalTime(body.targetTime);
  const origin = body.originDestinationId ?? null;
  const originDestinationId = origin === null ? null : positiveInt(origin);
  const companions = body.companions === undefined ? undefined : parseCompanions(body.companions);
  if (!passengerId || !destinationId || !direction || !targetTime || companions === null) return null;
  if (origin !== null && (originDestinationId === null || direction !== "entrada" || originDestinationId === destinationId)) return null;
  return { passengerId, direction, destinationId, originDestinationId, targetTime, companions };
}

const EXIT_TIME_REQUIRED = "exitTime is required for an entrada that starts at another Destino and must be before targetTime";
const EXIT_TIME_NOT_ALLOWED = "exitTime is only for an entrada that starts at another Destino";

// The time the Pasajero leaves the first Destino: required, and before T, only for an entrada that starts at a Destino.
function parseExitTime(value: unknown, originDestinationId: unknown, targetTime: string): { exitTime: string | null } | { error: string } {
  if (originDestinationId === null) {
    return value === undefined || value === null ? { exitTime: null } : { error: EXIT_TIME_NOT_ALLOWED };
  }
  const exitTime = parseLocalTime(value);
  return exitTime && exitTime < targetTime ? { exitTime } : { error: EXIT_TIME_REQUIRED };
}

const TRANSFER_SELECT_SQL = `
  SELECT
    t.id,
    t.passenger_id AS "passengerId",
    p.name AS "passengerName",
    t.direction,
    t.destination_id AS "destinationId",
    d.name AS "destinationName",
    t.origin_destination_id AS "originDestinationId",
    o.name AS "originDestinationName",
    to_char(t.target_time, 'HH24:MI') AS "targetTime",
    to_char(t.exit_time, 'HH24:MI') AS "exitTime",
    t.companions,
    t.status,
    s.route_id AS "routeId"
  FROM transfers t
  JOIN passengers p ON p.id = t.passenger_id
  JOIN destinations d ON d.id = t.destination_id
  LEFT JOIN destinations o ON o.id = t.origin_destination_id
  LEFT JOIN stops s ON s.transfer_id = t.id AND s.kind = 'pickup'
`;

function nullableNumber(value: unknown) {
  return value === null || value === undefined ? null : Number(value);
}

function formatTransferRow(row: Record<string, unknown>) {
  return {
    ...row,
    id: Number(row.id),
    passengerId: Number(row.passengerId),
    destinationId: Number(row.destinationId),
    originDestinationId: nullableNumber(row.originDestinationId),
    originDestinationName: (row.originDestinationName as string | null) ?? null,
    companions: Number(row.companions),
    routeId: nullableNumber(row.routeId),
  };
}

async function getTransferById(client: Queryable, transferId: number) {
  const result = await client.query(`${TRANSFER_SELECT_SQL} WHERE t.id = $1`, [transferId]) as QueryResult;
  return formatTransferRow(result.rows[0]);
}

const ROUTE_SELECT_SQL = `
  SELECT
    r.id,
    r.driver_id AS "driverId",
    dr.name AS "driverName",
    r.vehicle_id AS "vehicleId",
    v.plate AS "vehiclePlate",
    to_char(r.start_time, 'HH24:MI') AS "startTime",
    to_char(r.end_time, 'HH24:MI') AS "endTime",
    r.status,
    r.start_kind AS "startKind",
    r.start_latitude AS "startLat",
    r.start_longitude AS "startLng",
    r.end_kind AS "endKind",
    EXISTS (
      SELECT 1 FROM stops fs JOIN transfers ft ON ft.id = fs.transfer_id JOIN passengers fp ON fp.id = ft.passenger_id
       WHERE fs.route_id = r.id AND fp.front_seat
    ) AS "frontSeat"
  FROM routes r
  JOIN drivers dr ON dr.id = r.driver_id
  JOIN vehicles v ON v.id = r.vehicle_id
`;

// startKind and endKind are null while the Recorrido keeps the default start and end; frontSeat says it carries
// a Pasajero who needs the Asiento delantero.
function formatRouteRow(row: Record<string, unknown>) {
  return {
    ...row,
    id: Number(row.id),
    driverId: Number(row.driverId),
    vehicleId: Number(row.vehicleId),
    startLat: nullableNumber(row.startLat),
    startLng: nullableNumber(row.startLng),
    frontSeat: Boolean(row.frontSeat),
  };
}

async function getRouteById(client: Queryable, routeId: number) {
  const result = await client.query(`${ROUTE_SELECT_SQL} WHERE r.id = $1`, [routeId]) as QueryResult;
  return formatRouteRow(result.rows[0]);
}

// placeName is the Destino of the Parada, or null for the Pasajero's home.
const STOP_SELECT_SQL = `
  SELECT
    s.id,
    s.route_id AS "routeId",
    s.transfer_id AS "transferId",
    s.kind,
    s.position,
    s.leg_distance_meters AS "legDistanceMeters",
    to_char(s.planned_time, 'HH24:MI') AS "plannedTime",
    p.name AS "passengerName",
    CASE
      WHEN s.kind = 'pickup' AND t.direction = 'entrada' THEN o.name
      WHEN s.kind = 'pickup' OR t.direction = 'entrada' THEN d.name
    END AS "placeName"
  FROM stops s
  JOIN transfers t ON t.id = s.transfer_id
  JOIN passengers p ON p.id = t.passenger_id
  JOIN destinations d ON d.id = t.destination_id
  LEFT JOIN destinations o ON o.id = t.origin_destination_id
`;

async function findPlanId(client: Queryable, date: string) {
  const result = await client.query("SELECT id FROM daily_plans WHERE plan_date = $1", [date]) as QueryResult;
  if (!result.rows[0]) throw new PlanningError(404, "Plan diario not found");
  return Number(result.rows[0].id);
}

/** Day view: every Traslado of the day (assigned or not), those without a published Recorrido, and each Recorrido with its Paradas, km and latest version. */
async function loadDailyPlan(client: Queryable, date: string) {
  const planResult = await client.query(
    "SELECT id, to_char(plan_date, 'YYYY-MM-DD') AS date, time_zone AS \"timeZone\" FROM daily_plans WHERE plan_date = $1",
    [date],
  ) as QueryResult;
  const plan = planResult.rows[0];
  if (!plan) return null;
  const planId = Number(plan.id);
  const transfers = await client.query(
    `${TRANSFER_SELECT_SQL} WHERE t.daily_plan_id = $1 ORDER BY t.target_time, t.id`,
    [planId],
  ) as QueryResult;
  const routes = await client.query(
    `${ROUTE_SELECT_SQL} WHERE r.daily_plan_id = $1 ORDER BY r.start_time, r.id`,
    [planId],
  ) as QueryResult;
  const stops = await client.query(
    `${STOP_SELECT_SQL} WHERE t.daily_plan_id = $1 ORDER BY s.route_id, s.position`,
    [planId],
  ) as QueryResult;
  const versions = await client.query(
    `SELECT pv.route_id, max(pv.version) AS version FROM plan_versions pv JOIN routes r ON r.id = pv.route_id
      WHERE r.daily_plan_id = $1 GROUP BY pv.route_id`,
    [planId],
  ) as QueryResult;
  // A Traslado has a published Recorrido when the latest version of its current Recorrido serves it.
  const unpublished = await client.query(
    `SELECT t.id FROM transfers t LEFT JOIN stops s ON s.transfer_id = t.id AND s.kind = 'pickup'
      WHERE t.daily_plan_id = $1 AND t.status <> 'cancelado_ausencia'
        AND NOT EXISTS (
          SELECT 1 FROM plan_version_transfers pvt JOIN plan_versions pv ON pv.id = pvt.plan_version_id
           WHERE pvt.transfer_id = t.id AND pv.route_id = s.route_id
             AND pv.version = (SELECT max(version) FROM plan_versions latest WHERE latest.route_id = s.route_id))
      ORDER BY t.target_time, t.id`,
    [planId],
  ) as QueryResult;
  const stopRows = stops.rows.map((row) => ({
    ...row,
    id: Number(row.id),
    routeId: Number(row.routeId),
    transferId: Number(row.transferId),
    position: Number(row.position),
    legDistanceMeters: nullableNumber(row.legDistanceMeters),
    placeName: (row.placeName as string | null) ?? null,
    plannedTime: (row.plannedTime as string | null) ?? null,
  }));
  // km only from stored leg distances; null while any leg of the Recorrido has none, never a partial sum.
  const routeRows = routes.rows.map((row) => {
    const routeStops = stopRows.filter((stop) => stop.routeId === Number(row.id)).map(({ routeId: _, ...stop }) => stop);
    const complete = routeStops.every((stop) => stop.legDistanceMeters !== null);
    const meters = routeStops.reduce((sum, stop) => sum + (stop.legDistanceMeters ?? 0), 0);
    const version = versions.rows.find((item) => Number(item.route_id) === Number(row.id))?.version;
    return {
      route: { ...formatRouteRow(row), version: nullableNumber(version), km: complete ? meters / 1000 : null, stops: routeStops },
      meters,
    };
  });
  const dayKm = routeRows.some(({ route }) => route.km === null)
    ? null
    : routeRows.reduce((sum, { meters }) => sum + meters, 0) / 1000;
  return {
    plan: { id: planId, date: String(plan.date), timeZone: String(plan.timeZone) },
    transfers: transfers.rows.map(formatTransferRow),
    unpublishedTransferIds: unpublished.rows.map((item) => Number(item.id)),
    routes: routeRows.map(({ route }) => route),
    km: dayKm,
  };
}

async function lockRoute(client: Queryable, routeId: number) {
  const result = await client.query("SELECT id, daily_plan_id FROM routes WHERE id = $1 FOR UPDATE", [routeId]) as QueryResult;
  if (!result.rows[0]) throw new PlanningError(404, "Recorrido not found");
  return { id: routeId, dailyPlanId: Number(result.rows[0].daily_plan_id) };
}

// Renumbers the Paradas 1..n in their current order and drops the stored leg distances and planned times,
// which belonged to the old order.
async function settleStops(client: Queryable, routeId: number) {
  await client.query(
    `UPDATE stops s SET position = n.rn, leg_distance_meters = NULL, planned_time = NULL
       FROM (SELECT id, row_number() OVER (ORDER BY position, id) AS rn FROM stops WHERE route_id = $1) n
      WHERE s.id = n.id`,
    [routeId],
  );
}

async function appendStops(client: Queryable, routeId: number, transferId: number) {
  await client.query(
    `INSERT INTO stops (route_id, transfer_id, kind, position)
     SELECT $1, $2, k.kind, COALESCE((SELECT max(position) FROM stops WHERE route_id = $1), 0) + k.n
       FROM (VALUES ('pickup', 1), ('dropoff', 2)) AS k(kind, n)`,
    [routeId, transferId],
  );
}

/** Removes the Traslado's Paradas from its Recorrido (locked by the caller) and returns that Recorrido's id, or null. */
async function removeStops(client: Queryable, transferId: number) {
  const removed = await client.query("DELETE FROM stops WHERE transfer_id = $1 RETURNING route_id", [transferId]) as QueryResult;
  const routeId = removed.rows[0] ? Number(removed.rows[0].route_id) : null;
  if (routeId !== null) await settleStops(client, routeId);
  return routeId;
}

// A Traslado reaches a Recorrido only when its Pasajero has a Consentimiento; a recorded one is never removed, so no lock is needed.
async function assertConsent(client: Queryable, transferIds: number[]) {
  const missing = await client.query(
    `SELECT DISTINCT p.id, p.name FROM transfers t JOIN passengers p ON p.id = t.passenger_id
      WHERE t.id = ANY($1::int[]) AND NOT EXISTS (SELECT 1 FROM consents c WHERE c.passenger_id = p.id)
      ORDER BY p.name, p.id`,
    [transferIds],
  ) as QueryResult;
  if (missing.rows.length) {
    const names = missing.rows.map((row) => String(row.name)).join(", ");
    throw new PlanningError(409, `No Consentimiento recorded for ${names}: record it before assigning a Recorrido`);
  }
}

// The Recorrido's Vehículo defaults to the Chofer's usual Vehículo and must be active.
async function chooseVehicle(client: Queryable, driverId: number, requested: unknown) {
  const driver = await client.query("SELECT usual_vehicle_id FROM drivers WHERE id = $1 FOR UPDATE", [driverId]) as QueryResult;
  if (!driver.rows[0]) throw new PlanningError(400, "Invalid request");
  const vehicleId = requested === undefined || requested === null
    ? nullableNumber(driver.rows[0].usual_vehicle_id)
    : positiveInt(requested);
  if (vehicleId === null) {
    throw new PlanningError(400, requested === undefined || requested === null
      ? "This Chofer has no usual Vehículo: choose one"
      : "Invalid request");
  }
  await assertActiveUsualVehicle(client, vehicleId);
  return vehicleId;
}

async function insertRoute(client: Queryable, actorId: number, planId: number, fields: {
  driverId: number;
  vehicleId: number;
  startTime: string;
  endTime: string;
}) {
  const inserted = await client.query(
    "INSERT INTO routes (daily_plan_id, driver_id, vehicle_id, start_time, end_time) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    [planId, fields.driverId, fields.vehicleId, fields.startTime, fields.endTime],
  ) as QueryResult;
  const id = Number(inserted.rows[0].id);
  await appendChange(client, actorId, "route", String(id), "created", null, { dailyPlanId: planId, ...fields });
  return id;
}

const START_KINDS = ["home", "previous", "point"];
const END_KINDS = ["home", "open"];

// Start and end settings of PATCH /routes/:id; a null kind goes back to the default rule, undefined leaves it unchanged.
function parseRouteEnds(body: Record<string, unknown>) {
  const result: { start?: { kind: string | null; lat: number | null; lng: number | null }; endKind?: string | null } = {};
  if (body.startKind !== undefined) {
    const kind = body.startKind;
    if (kind !== null && (typeof kind !== "string" || !START_KINDS.includes(kind))) return null;
    if (kind === "point") {
      const lat = coordinate(body.startLat, 90);
      const lng = coordinate(body.startLng, 180);
      if (lat === null || lng === null) return null;
      result.start = { kind, lat, lng };
    } else {
      if ((body.startLat ?? null) !== null || (body.startLng ?? null) !== null) return null;
      result.start = { kind, lat: null, lng: null };
    }
  } else if (body.startLat !== undefined || body.startLng !== undefined) {
    return null;
  }
  if (body.endKind !== undefined) {
    if (body.endKind !== null && (typeof body.endKind !== "string" || !END_KINDS.includes(body.endKind))) return null;
    result.endKind = body.endKind;
  }
  return result;
}

const ORDER_ROUTE_SQL = `
  SELECT r.daily_plan_id, r.driver_id, r.vehicle_id, r.status, to_char(r.start_time, 'HH24:MI') AS start_time,
         r.start_kind, r.start_latitude, r.start_longitude, r.end_kind, v.seats,
         ARRAY(SELECT feature_id FROM vehicle_feature_assignments WHERE vehicle_id = v.id ORDER BY feature_id) AS feature_ids,
         dr.home_latitude, dr.home_longitude
    FROM routes r JOIN vehicles v ON v.id = r.vehicle_id JOIN drivers dr ON dr.id = r.driver_id
   WHERE r.id = $1`;

// One row per Traslado of the Recorrido, in its current order, with what the engine and the validator need.
const ORDER_TRANSFERS_SQL = `
  SELECT t.id, t.passenger_id, t.direction, to_char(t.target_time, 'HH24:MI') AS target,
         to_char(t.exit_time, 'HH24:MI') AS exit_time, t.companions, p.name,
         p.home_latitude, p.home_longitude, p.front_seat, p.max_ride_time_minutes, p.pickup_duration_minutes,
         p.dropoff_duration_minutes, d.latitude AS d_lat, d.longitude AS d_lng, d.arrival_tolerance_minutes,
         o.latitude AS o_lat, o.longitude AS o_lng,
         ARRAY(SELECT feature_id FROM passenger_required_features f WHERE f.passenger_id = p.id ORDER BY feature_id) AS feature_ids
    FROM stops s
    JOIN transfers t ON t.id = s.transfer_id
    JOIN passengers p ON p.id = t.passenger_id
    JOIN destinations d ON d.id = t.destination_id
    LEFT JOIN destinations o ON o.id = t.origin_destination_id
   WHERE s.route_id = $1 AND s.kind = 'pickup'
   ORDER BY s.position`;

// Where the last Parada of a Recorrido is and when its service ends (null while it has no planned time).
const LAST_STOP_SQL = `
  SELECT CASE WHEN (s.kind = 'pickup') = (t.direction = 'entrada') THEN COALESCE(o.latitude, p.home_latitude) ELSE d.latitude END AS lat,
         CASE WHEN (s.kind = 'pickup') = (t.direction = 'entrada') THEN COALESCE(o.longitude, p.home_longitude) ELSE d.longitude END AS lng,
         EXTRACT(EPOCH FROM s.planned_time) / 60
           + CASE s.kind WHEN 'pickup' THEN p.pickup_duration_minutes ELSE p.dropoff_duration_minutes END AS planned_end
    FROM stops s
    JOIN transfers t ON t.id = s.transfer_id
    JOIN passengers p ON p.id = t.passenger_id
    JOIN destinations d ON d.id = t.destination_id
    LEFT JOIN destinations o ON o.id = t.origin_destination_id
   WHERE s.route_id = $1
   ORDER BY s.position DESC
   LIMIT 1`;

function lngLat(lat: unknown, lng: unknown): LngLat {
  return [Number(lng), Number(lat)];
}

type Neighbours = { previous?: Record<string, unknown>; last?: Record<string, unknown>; next?: Record<string, unknown> };

// The same Chofer's Recorridos right before and after this one and the previous one's last Parada, which decide
// where this one starts and ends.
async function loadNeighbours(client: Queryable, routeId: number, route: Record<string, unknown>): Promise<Neighbours> {
  const values = [route.daily_plan_id, route.driver_id, routeId, String(route.start_time)];
  const previousResult = await client.query(
    `SELECT id, vehicle_id, end_kind, to_char(end_time, 'HH24:MI') AS end_time FROM routes
      WHERE daily_plan_id = $1 AND driver_id = $2 AND id <> $3 AND (start_time < $4 OR (start_time = $4 AND id < $3))
      ORDER BY start_time DESC, id DESC LIMIT 1`,
    values,
  ) as QueryResult;
  const nextResult = await client.query(
    `SELECT id FROM routes
      WHERE daily_plan_id = $1 AND driver_id = $2 AND id <> $3 AND (start_time > $4 OR (start_time = $4 AND id > $3))
      ORDER BY start_time, id LIMIT 1`,
    values,
  ) as QueryResult;
  const previous = previousResult.rows[0];
  const last = previous ? (await client.query(LAST_STOP_SQL, [previous.id]) as QueryResult).rows[0] : undefined;
  return { previous, last, next: nextResult.rows[0] };
}

/**
 * Start and end of the Recorrido for the engine. Default start: the Chofer's home for their first Recorrido of the day
 * or after a gap longer than routeGapMinutes; otherwise the previous Recorrido's last Parada when it used the same
 * Vehículo, else the Oficina must set it. Default end: home for the Chofer's last Recorrido of the day, open otherwise.
 * "Previous" is the same Chofer's Recorrido with the latest earlier start; its planned end bounds this one's departure.
 * When the Oficina set the previous one to end at home, the chain starts there instead of at its last Parada.
 */
function resolveRouteEnds(route: Record<string, unknown>, { previous, last, next }: Neighbours, routeGapMinutes: number) {
  const home = lngLat(route.home_latitude, route.home_longitude);
  const startTime = String(route.start_time);
  let previousEnd: number | undefined;
  if (previous) {
    previousEnd = last?.planned_end === null || last?.planned_end === undefined
      ? minutesOf(String(previous.end_time))
      : Math.ceil(Number(last.planned_end));
  }
  const previousStop = last ? lngLat(last.lat, last.lng) : null;
  const chained = previousStop && previous!.end_kind === "home" ? home : previousStop;

  let start: LngLat;
  if (route.start_kind === "home") start = home;
  else if (route.start_kind === "point") start = lngLat(route.start_latitude, route.start_longitude);
  else if (route.start_kind === "previous") {
    if (!chained) throw new PlanningError(409, "This Recorrido has no previous Recorrido with Paradas to start from");
    start = chained;
  } else if (previousEnd === undefined || minutesOf(startTime) - previousEnd > routeGapMinutes) start = home;
  else if (chained && Number(previous!.vehicle_id) === Number(route.vehicle_id)) start = chained;
  else throw new PlanningError(409, "Set where this Recorrido starts: the previous Recorrido has another Vehículo or no Paradas");

  const endKind = route.end_kind ?? (next ? "open" : "home");
  return { start, end: endKind === "home" ? home : null, previousEnd, previousStop, previousEndPoint: chained };
}

function stopLocation(row: Record<string, unknown>, kind: "pickup" | "dropoff"): LngLat {
  const home = lngLat(row.home_latitude, row.home_longitude);
  const destination = lngLat(row.d_lat, row.d_lng);
  if (row.direction === "salida") return kind === "pickup" ? destination : home;
  if (kind === "dropoff") return destination;
  return row.o_lat === null ? home : lngLat(row.o_lat, row.o_lng);
}

function toPlanTransfer(row: Record<string, unknown>): PlanTransfer {
  return {
    id: Number(row.id),
    direction: row.direction as "entrada" | "salida",
    targetMinutes: minutesOf(String(row.target)),
    ...(row.exit_time === null ? {} : { notBeforeMinutes: minutesOf(String(row.exit_time)) }),
    pickup: stopLocation(row, "pickup"),
    dropoff: stopLocation(row, "dropoff"),
    seats: 1 + Number(row.companions),
    frontSeat: Boolean(row.front_seat),
    requiredFeatureIds: (row.feature_ids as number[]).map(Number),
    maxRideMinutes: Number(row.max_ride_time_minutes),
    pickupMinutes: Number(row.pickup_duration_minutes),
    dropoffMinutes: Number(row.dropoff_duration_minutes),
  };
}

// The applied order checked by the route validator; entradas accept arrival up to T + the Destino's Tolerancia de llegada.
function validateOrder(
  rows: Record<string, unknown>[],
  stops: { transferId: number; kind: "pickup" | "dropoff"; plannedSeconds: number }[],
  route: Record<string, unknown>,
) {
  const placed = new Set(stops.map((stop) => stop.transferId));
  const served = rows.filter((row) => placed.has(Number(row.id)));
  const validatorStops: ValidatorStop[] = stops.map((stop) => ({
    id: `${stop.transferId}-${stop.kind}`,
    transferId: String(stop.transferId),
    type: stop.kind,
    plannedTime: stop.plannedSeconds / 60,
  }));
  return validateRoute({
    route: validatorStops,
    passengers: served.map((row) => ({
      id: String(row.passenger_id),
      maxRideTimeMinutes: Number(row.max_ride_time_minutes),
      frontSeat: Boolean(row.front_seat),
      dropoffDurationMinutes: Number(row.dropoff_duration_minutes),
      requiredFeatures: (row.feature_ids as number[]).map(String),
    })),
    vehicle: { id: "vehicle", capacity: { seats: Number(route.seats), front: 1 }, features: (route.feature_ids as number[]).map(String) },
    transfers: served.map((row) => ({
      id: String(row.id),
      passengerId: String(row.passenger_id),
      direction: row.direction as "entrada" | "salida",
      targetTime: minutesOf(String(row.target)),
      companions: Number(row.companions),
      ...(row.direction === "entrada" ? { lateToleranceMinutes: Number(row.arrival_tolerance_minutes) } : {}),
    })),
  });
}

type Point = { lat: number; lng: number };

// Where a Parada is: an entrada is picked up at its origin Destino or at home and dropped at its Destino;
// a salida is picked up at its Destino and dropped at home. Expects aliases t (transfers), p (passengers),
// d (destinations) and o (origin destinations), and the Parada kind as `kindSql`.
function stopPointSql(kindSql: string) {
  const home = `${kindSql} = 'pickup' AND t.direction = 'entrada'`;
  return `
    CASE WHEN ${home} THEN COALESCE(o.latitude, p.home_latitude)
         WHEN ${kindSql} = 'dropoff' AND t.direction = 'salida' THEN p.home_latitude
         ELSE d.latitude END AS lat,
    CASE WHEN ${home} THEN COALESCE(o.longitude, p.home_longitude)
         WHEN ${kindSql} = 'dropoff' AND t.direction = 'salida' THEN p.home_longitude
         ELSE d.longitude END AS lng,
    CASE WHEN ${kindSql} = 'pickup' THEN p.pickup_duration_minutes ELSE p.dropoff_duration_minutes END AS "serviceMinutes"`;
}

const TRANSFER_PLACES_SQL = `
  JOIN transfers t ON t.id = s.transfer_id
  JOIN passengers p ON p.id = t.passenger_id
  JOIN destinations d ON d.id = t.destination_id
  LEFT JOIN destinations o ON o.id = t.origin_destination_id`;

type PublicationStop = {
  transferId: number;
  kind: "pickup" | "dropoff";
  point: Point;
  serviceMinutes: number;
};
type PublicationTransfer = {
  id: number;
  passengerId: number;
  passengerName: string;
  direction: "entrada" | "salida";
  targetTime: string;
  companions: number;
  maxRideTimeMinutes: number;
  pickupDurationMinutes: number;
  dropoffDurationMinutes: number;
  frontSeat: boolean;
  requiredFeatures: string[];
  // The Distancia directa runs from where the Traslado starts to where it ends, on its own.
  from: Point;
  to: Point;
};
type PublicationSnapshot = {
  route: { id: number; dailyPlanId: number; driverId: number; vehicleId: number; startTime: string; endTime: string; status: string };
  vehicle: { seats: number; features: string[] };
  stops: PublicationStop[];
  transfers: PublicationTransfer[];
};

/** Everything a publication reads about one Recorrido, in Parada order. */
async function loadPublicationSnapshot(client: Queryable, routeId: number): Promise<PublicationSnapshot> {
  const routeResult = await client.query(
    `SELECT r.id, r.daily_plan_id, r.driver_id, r.vehicle_id, to_char(r.start_time, 'HH24:MI') AS start_time,
            to_char(r.end_time, 'HH24:MI') AS end_time, r.status, v.seats,
            COALESCE(array_agg(f.feature_id::text) FILTER (WHERE f.feature_id IS NOT NULL), '{}') AS features
       FROM routes r JOIN vehicles v ON v.id = r.vehicle_id
       LEFT JOIN vehicle_feature_assignments f ON f.vehicle_id = v.id
      WHERE r.id = $1 GROUP BY r.id, v.id`,
    [routeId],
  ) as QueryResult;
  const row = routeResult.rows[0];
  if (!row) throw new PlanningError(404, "Recorrido not found");
  const stopResult = await client.query(
    `SELECT s.transfer_id AS "transferId", s.kind, ${stopPointSql("s.kind")}
       FROM stops s ${TRANSFER_PLACES_SQL}
      WHERE s.route_id = $1 ORDER BY s.position, s.id`,
    [routeId],
  ) as QueryResult;
  const transferResult = await client.query(
    `SELECT t.id, t.passenger_id AS "passengerId", p.name AS "passengerName", t.direction,
            to_char(t.target_time, 'HH24:MI') AS "targetTime", t.companions,
            p.max_ride_time_minutes AS "maxRideTimeMinutes", p.pickup_duration_minutes AS "pickupDurationMinutes",
            p.dropoff_duration_minutes AS "dropoffDurationMinutes", p.front_seat AS "frontSeat",
            COALESCE(array_agg(rf.feature_id::text) FILTER (WHERE rf.feature_id IS NOT NULL), '{}') AS "requiredFeatures",
            COALESCE(o.latitude, CASE WHEN t.direction = 'entrada' THEN p.home_latitude ELSE d.latitude END) AS "fromLat",
            COALESCE(o.longitude, CASE WHEN t.direction = 'entrada' THEN p.home_longitude ELSE d.longitude END) AS "fromLng",
            CASE WHEN t.direction = 'entrada' THEN d.latitude ELSE p.home_latitude END AS "toLat",
            CASE WHEN t.direction = 'entrada' THEN d.longitude ELSE p.home_longitude END AS "toLng"
       FROM transfers t
       JOIN passengers p ON p.id = t.passenger_id
       JOIN destinations d ON d.id = t.destination_id
       LEFT JOIN destinations o ON o.id = t.origin_destination_id
       LEFT JOIN passenger_required_features rf ON rf.passenger_id = p.id
      WHERE t.id IN (SELECT transfer_id FROM stops WHERE route_id = $1)
      GROUP BY t.id, p.id, d.id, o.id ORDER BY t.id`,
    [routeId],
  ) as QueryResult;
  return {
    route: {
      id: routeId,
      dailyPlanId: Number(row.daily_plan_id),
      driverId: Number(row.driver_id),
      vehicleId: Number(row.vehicle_id),
      startTime: String(row.start_time),
      endTime: String(row.end_time),
      status: String(row.status),
    },
    vehicle: { seats: Number(row.seats), features: row.features as string[] },
    stops: stopResult.rows.map((stop) => ({
      transferId: Number(stop.transferId),
      kind: stop.kind as "pickup" | "dropoff",
      point: { lat: Number(stop.lat), lng: Number(stop.lng) },
      serviceMinutes: Number(stop.serviceMinutes),
    })),
    transfers: transferResult.rows.map((transfer) => ({
      id: Number(transfer.id),
      passengerId: Number(transfer.passengerId),
      passengerName: String(transfer.passengerName),
      direction: transfer.direction as "entrada" | "salida",
      targetTime: String(transfer.targetTime),
      companions: Number(transfer.companions),
      maxRideTimeMinutes: Number(transfer.maxRideTimeMinutes),
      pickupDurationMinutes: Number(transfer.pickupDurationMinutes),
      dropoffDurationMinutes: Number(transfer.dropoffDurationMinutes),
      frontSeat: Boolean(transfer.frontSeat),
      requiredFeatures: transfer.requiredFeatures as string[],
      from: { lat: Number(transfer.fromLat), lng: Number(transfer.fromLng) },
      to: { lat: Number(transfer.toLat), lng: Number(transfer.toLng) },
    })),
  };
}

/**
 * What a Versión del plan was computed from: every input of the snapshot, so any change that can move distances, times
 * or the validator's verdict changes it. Left out: the status, which publishing itself changes, and the Pasajero's name.
 */
function publicationSignature(snapshot: PublicationSnapshot) {
  const { status: _status, ...route } = snapshot.route;
  const transfers = snapshot.transfers.map(({ passengerName: _name, ...transfer }) => transfer);
  return createHash("sha256").update(JSON.stringify({ route, vehicle: snapshot.vehicle, stops: snapshot.stops, transfers })).digest("hex");
}

async function latestVersionSignature(client: Queryable, routeId: number) {
  const version = await client.query(
    "SELECT version, input_signature FROM plan_versions WHERE route_id = $1 ORDER BY version DESC LIMIT 1",
    [routeId],
  ) as QueryResult;
  const row = version.rows[0];
  return row ? { version: Number(row.version), signature: String(row.input_signature) } : null;
}

type GroupedViolations = { passengerId: number; passengerName: string; violations: { rule: string; transferId: number | null; message: string }[] }[];

function groupByPassenger(violations: RouteViolation[], transfers: PublicationTransfer[]): GroupedViolations {
  const groups = new Map<number, GroupedViolations[number]>();
  for (const violation of violations) {
    const passengerId = Number(violation.passengerId);
    const name = transfers.find((transfer) => transfer.passengerId === passengerId)?.passengerName ?? "";
    const group = groups.get(passengerId) ?? { passengerId, passengerName: name, violations: [] };
    group.violations.push({
      rule: violation.rule,
      transferId: violation.transferId === undefined ? null : Number(violation.transferId),
      message: violation.message,
    });
    groups.set(passengerId, group);
  }
  return [...groups.values()];
}

function clockOfSeconds(seconds: number) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}

/**
 * Planned minute of each Parada: the latest start that puts every target Parada (an entrada's drop-off, a salida's
 * pickup) on or before its target time; each next Parada follows after the service at the previous one and the leg.
 */
function plannedMinutes(snapshot: PublicationSnapshot, legs: RouteLeg[]) {
  const relative: number[] = [];
  snapshot.stops.forEach((stop, index) => {
    relative.push(index === 0 ? 0 : relative[index - 1] + snapshot.stops[index - 1].serviceMinutes + legs[index].durationSeconds / 60);
  });
  const slack = snapshot.stops.flatMap((stop, index) => {
    const transfer = snapshot.transfers.find((candidate) => candidate.id === stop.transferId)!;
    const isTarget = (transfer.direction === "entrada") === (stop.kind === "dropoff");
    return isTarget ? [minutesOf(transfer.targetTime) - relative[index]] : [];
  });
  const start = slack.length ? Math.min(...slack) : minutesOf(snapshot.route.startTime);
  return relative.map((minutes) => start + minutes);
}

function validatePublication(snapshot: PublicationSnapshot, planned: number[]) {
  return validateRoute({
    route: snapshot.stops.map((stop, index) => ({
      id: String(index + 1),
      transferId: String(stop.transferId),
      type: stop.kind,
      plannedTime: planned[index],
    })),
    passengers: [...new Map(snapshot.transfers.map((transfer) => [transfer.passengerId, {
      id: String(transfer.passengerId),
      maxRideTimeMinutes: transfer.maxRideTimeMinutes,
      frontSeat: transfer.frontSeat,
      requiredFeatures: transfer.requiredFeatures,
      pickupDurationMinutes: transfer.pickupDurationMinutes,
      dropoffDurationMinutes: transfer.dropoffDurationMinutes,
    }])).values()],
    vehicle: { id: String(snapshot.route.vehicleId), capacity: { seats: snapshot.vehicle.seats, front: 1 }, features: snapshot.vehicle.features },
    transfers: snapshot.transfers.map((transfer) => ({
      id: String(transfer.id),
      passengerId: String(transfer.passengerId),
      direction: transfer.direction,
      targetTime: minutesOf(transfer.targetTime),
      companions: transfer.companions,
    })),
  });
}

// Everything the engine was given, the neighbouring Recorridos included; the result is applied only while this is unchanged.
async function orderInputKey(client: Queryable, routeId: number) {
  const route = (await client.query(ORDER_ROUTE_SQL, [routeId]) as QueryResult).rows[0];
  const rows = route ? (await client.query(ORDER_TRANSFERS_SQL, [routeId]) as QueryResult).rows : [];
  const neighbours = route ? await loadNeighbours(client, routeId, route) : {};
  return { route, rows, neighbours, key: JSON.stringify([route, rows, neighbours]) };
}

const PLAN_VERSION_SELECT_SQL = `
  SELECT pv.id, pv.route_id AS "routeId", pv.version, pv.vehicle_id AS "vehicleId", v.plate AS "vehiclePlate",
         pv.driver_id AS "driverId", to_char(pv.start_time, 'HH24:MI') AS "startTime", to_char(pv.end_time, 'HH24:MI') AS "endTime",
         pv.published_at AS "publishedAt", pv.published_by AS "publishedBy", pv.override_reason AS "overrideReason", pv.violations
    FROM plan_versions pv JOIN vehicles v ON v.id = pv.vehicle_id`;

/**
 * Versiones del plan of a Recorrido with their legs and Traslados. directDistanceMeters is the Distancia directa, the
 * only km per Traslado; plannedRideMeters is derived from the legs the Pasajero rides and is not called that.
 */
async function loadPlanVersions(client: Queryable, where: string, values: unknown[]) {
  const versions = await client.query(`${PLAN_VERSION_SELECT_SQL} WHERE ${where} ORDER BY pv.version`, values) as QueryResult;
  const ids = versions.rows.map((row) => Number(row.id));
  const legs = await client.query(
    `SELECT plan_version_id, position, transfer_id, kind, distance_meters, duration_seconds, to_char(planned_time, 'HH24:MI') AS planned_time
       FROM plan_version_legs WHERE plan_version_id = ANY($1::int[]) ORDER BY plan_version_id, position`,
    [ids],
  ) as QueryResult;
  const transfers = await client.query(
    `SELECT plan_version_id, transfer_id, companions, direct_distance_meters
       FROM plan_version_transfers WHERE plan_version_id = ANY($1::int[]) ORDER BY plan_version_id, transfer_id`,
    [ids],
  ) as QueryResult;
  return versions.rows.map((row) => {
    const versionLegs = legs.rows.filter((leg) => Number(leg.plan_version_id) === Number(row.id)).map((leg) => ({
      position: Number(leg.position),
      transferId: Number(leg.transfer_id),
      kind: String(leg.kind),
      distanceMeters: Number(leg.distance_meters),
      durationSeconds: Number(leg.duration_seconds),
      plannedTime: String(leg.planned_time),
    }));
    return {
      routeId: Number(row.routeId),
      version: Number(row.version),
      vehicleId: Number(row.vehicleId),
      vehiclePlate: String(row.vehiclePlate),
      driverId: Number(row.driverId),
      startTime: String(row.startTime),
      endTime: String(row.endTime),
      publishedAt: new Date(String(row.publishedAt)).toISOString(),
      publishedBy: Number(row.publishedBy),
      overrideReason: (row.overrideReason as string | null) ?? null,
      violations: row.violations as GroupedViolations,
      legs: versionLegs,
      transfers: transfers.rows.filter((item) => Number(item.plan_version_id) === Number(row.id)).map((item) => {
        const transferId = Number(item.transfer_id);
        const pickup = versionLegs.find((leg) => leg.transferId === transferId && leg.kind === "pickup")!;
        const dropoff = versionLegs.find((leg) => leg.transferId === transferId && leg.kind === "dropoff")!;
        return {
          transferId,
          companions: Number(item.companions),
          directDistanceMeters: Number(item.direct_distance_meters),
          plannedRideMeters: versionLegs
            .filter((leg) => leg.position > pickup.position && leg.position <= dropoff.position)
            .reduce((sum, leg) => sum + leg.distanceMeters, 0),
        };
      }),
    };
  });
}

export type CascadeWarning = { routeId: number; version: number; fromRouteId: number; ok: boolean; problem: string | null };

export function createApp({ db, routing, router, geocoder, solver, travelTime, config }: {
  db: HealthDatabase;
  routing: RoutingHealth;
  router?: Router;
  geocoder?: Geocoder;
  // Solve VROOM problems and measure driving time for "Order"; without them ordering answers 503.
  solver?: VroomSolver;
  travelTime?: TravelTime;
  config: AppConfig;
}) {
  if (!config.serverEpoch.trim()) throw new Error("SERVER_EPOCH is required");
  const healthTimeoutMs = config.healthTimeoutMs ?? 1000;
  const routeGapMinutes = config.routeGapMinutes ?? 60;
  const plannerSettings = config.planner ?? { rideTimeBufferMinutes: 5, speedFactors: [], earlyToleranceMinutes: 15 };
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
  /**
   * Publishes the Recorrido as its next Versión del plan. It reads the Recorrido and asks OSRM outside the transaction,
   * then publishes only if nothing it read changed meanwhile. With `onlyIfChanged` (the whole Plan diario), a Recorrido
   * equal to its latest version keeps that version instead of getting a new one.
   */
  async function publishRoute(actorId: number, routeId: number, reason: string | null, onlyIfChanged = false) {
    const before = await loadPublicationSnapshot(db, routeId);
    if (!before.stops.length) throw new PlanningError(409, "A Recorrido without Paradas cannot be published");
    const expected = publicationSignature(before);
    const latest = onlyIfChanged ? await latestVersionSignature(db, routeId) : null;
    if (latest?.signature === expected) {
      const [version] = await loadPlanVersions(db, "pv.route_id = $1 AND pv.version = $2", [routeId, latest.version]);
      return { created: false, version, cascade: [] as CascadeWarning[] };
    }
    let legs: RouteLeg[];
    let direct: RouteLeg[];
    try {
      if (!router) throw new Error("No router configured");
      const route = router;
      legs = [{ distanceMeters: 0, durationSeconds: 0 }, ...(before.stops.length > 1 ? await route(before.stops.map((stop) => stop.point)) : [])];
      direct = await Promise.all(before.transfers.map(async (transfer) => (await route([transfer.from, transfer.to]))[0]));
    } catch {
      throw new PlanningError(502, "Routing is unavailable: try publishing again");
    }
    const published = await inTransaction(db, async (client) => {
      await lockRoute(client, routeId);
      const snapshot = await loadPublicationSnapshot(client, routeId);
      // Places, limits and order must be what OSRM was asked about.
      if (JSON.stringify(snapshot) !== JSON.stringify(before)) {
        throw new PlanningError(409, "The Recorrido changed while it was being published: publish it again");
      }
      const current = await latestVersionSignature(client, routeId);
      if (onlyIfChanged && current?.signature === expected) return { created: false, version: current.version };
      const { dailyPlanId, driverId, vehicleId, startTime, endTime, status } = snapshot.route;
      // Every publication locks the Chofer, then the Vehículo, so two of them cannot deadlock or both pass the overlap check.
      await client.query("SELECT id FROM drivers WHERE id = $1 FOR UPDATE", [driverId]);
      await client.query("SELECT id FROM vehicles WHERE id = $1 FOR UPDATE", [vehicleId]);
      const overlap = await client.query(
        `SELECT COALESCE(bool_or(pv.driver_id = $3), false) AS driver, COALESCE(bool_or(pv.vehicle_id = $4), false) AS vehicle
           FROM plan_versions pv JOIN routes r ON r.id = pv.route_id
          WHERE r.daily_plan_id = $1 AND pv.route_id <> $2
            AND pv.version = (SELECT max(version) FROM plan_versions latest WHERE latest.route_id = pv.route_id)
            AND (pv.driver_id = $3 OR pv.vehicle_id = $4) AND pv.start_time < $6::time AND $5::time < pv.end_time`,
        [dailyPlanId, routeId, driverId, vehicleId, startTime, endTime],
      ) as QueryResult;
      if (overlap.rows[0].driver) throw new PlanningError(409, "The Chofer is in another published Recorrido at the same time");
      if (overlap.rows[0].vehicle) throw new PlanningError(409, "The Vehículo is in another published Recorrido at the same time");
      const planned = plannedMinutes(snapshot, legs);
      const violations = groupByPassenger(validatePublication(snapshot, planned), snapshot.transfers);
      if (violations.some((group) => group.violations.some((violation) => violation.rule === "unserved_transfer"))) {
        throw new PlanningError(409, "A Recorrido that leaves a Traslado unserved is never published, even forced", { violations });
      }
      if (violations.length && !reason) {
        throw new PlanningError(409, "The Recorrido breaks limits: fix it or publish it with a reason", { violations });
      }
      const seconds = planned.map((minutes) => Math.round(minutes * 60));
      if (seconds.some((value) => value < 0 || value >= 24 * 3600)) {
        throw new PlanningError(409, "The Recorrido's planned times fall outside its day");
      }
      const version = (current?.version ?? 0) + 1;
      const overrideReason = violations.length ? reason : null;
      const inserted = await client.query(
        `INSERT INTO plan_versions (route_id, version, vehicle_id, driver_id, start_time, end_time, published_by, override_reason, violations, input_signature)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [routeId, version, vehicleId, driverId, startTime, endTime, actorId, overrideReason, JSON.stringify(violations), expected],
      ) as QueryResult;
      const versionId = Number(inserted.rows[0].id);
      const distances = legs.map((leg) => Math.round(leg.distanceMeters));
      await client.query(
        `INSERT INTO plan_version_legs (plan_version_id, position, transfer_id, kind, distance_meters, duration_seconds, planned_time)
         SELECT $1, l.n, l.transfer_id, l.kind, l.distance, l.duration, l.planned::time
           FROM unnest($2::int[], $3::text[], $4::int[], $5::int[], $6::text[])
                WITH ORDINALITY AS l(transfer_id, kind, distance, duration, planned, n)`,
        [
          versionId,
          snapshot.stops.map((stop) => stop.transferId),
          snapshot.stops.map((stop) => stop.kind),
          distances,
          legs.map((leg) => Math.round(leg.durationSeconds)),
          seconds.map(clockOfSeconds),
        ],
      );
      await client.query(
        `INSERT INTO plan_version_transfers (plan_version_id, transfer_id, companions, direct_distance_meters)
         SELECT $1, t.id, t.companions, t.direct FROM unnest($2::int[], $3::int[], $4::int[]) AS t(id, companions, direct)`,
        [
          versionId,
          snapshot.transfers.map((transfer) => transfer.id),
          snapshot.transfers.map((transfer) => transfer.companions),
          direct.map((leg) => Math.round(leg.distanceMeters)),
        ],
      );
      // The current order gets the published legs, so the day view shows its km.
      await client.query(
        `UPDATE stops s SET leg_distance_meters = l.distance
           FROM (SELECT id, row_number() OVER (ORDER BY position, id) AS n FROM stops WHERE route_id = $1) o
           JOIN unnest($2::int[]) WITH ORDINALITY AS l(distance, n) ON l.n = o.n
          WHERE s.id = o.id`,
        [routeId, distances],
      );
      const nextStatus = status === "borrador" ? "publicado" : status;
      await client.query("UPDATE routes SET status = $2 WHERE id = $1", [routeId, nextStatus]);
      await appendChange(client, actorId, "route", String(routeId), "published", { version: current?.version ?? null, status }, {
        version, status: nextStatus, vehicleId, overrideReason, violations,
      });
      return { created: true, version };
    });
    const [version] = await loadPlanVersions(db, "pv.route_id = $1 AND pv.version = $2", [routeId, published.version]);
    const cascade = published.created ? await revalidateChained(actorId, routeId) : [];
    return { created: published.created, version, cascade };
  }

  /** A Parada of a published version: its planned minute, where it is and how long its service takes. */
  async function versionStop(routeId: number, version: number, last: boolean) {
    const result = await db.query(
      `SELECT extract(epoch FROM s.planned_time) / 60 AS minutes, ${stopPointSql("s.kind")}
         FROM plan_version_legs s JOIN plan_versions pv ON pv.id = s.plan_version_id ${TRANSFER_PLACES_SQL}
        WHERE pv.route_id = $1 AND pv.version = $2 ORDER BY s.position ${last ? "DESC" : "ASC"} LIMIT 1`,
      [routeId, version],
    ) as QueryResult;
    const row = result.rows[0];
    return { minutes: Number(row.minutes), serviceMinutes: Number(row.serviceMinutes), point: { lat: Number(row.lat), lng: Number(row.lng) } };
  }

  /**
   * After Recorrido k is published, its Chofer's next published Recorrido is chained when it starts no more than
   * routeGapMinutes after k ends. It is revalidated (can the Chofer reach its first Parada in time after k's last one?)
   * and the Oficina is warned through the change log and the answer. It is never republished here.
   */
  async function revalidateChained(actorId: number, routeId: number): Promise<CascadeWarning[]> {
    const chain = await db.query(
      `WITH latest AS (
         SELECT DISTINCT ON (pv.route_id) pv.route_id, pv.version, pv.driver_id, pv.start_time, pv.end_time
           FROM plan_versions pv JOIN routes r ON r.id = pv.route_id
          WHERE r.daily_plan_id = (SELECT daily_plan_id FROM routes WHERE id = $1)
          ORDER BY pv.route_id, pv.version DESC)
       SELECT k.version AS "fromVersion", n.route_id AS "routeId", n.version,
              extract(epoch FROM n.start_time - k.end_time) / 60 AS gap
         FROM latest k JOIN latest n ON n.driver_id = k.driver_id AND (n.start_time, n.route_id) > (k.start_time, k.route_id)
        WHERE k.route_id = $1 ORDER BY n.start_time, n.route_id LIMIT 1`,
      [routeId],
    ) as QueryResult;
    const next = chain.rows[0];
    if (!next || Number(next.gap) > routeGapMinutes) return [];
    const nextId = Number(next.routeId);
    const nextVersion = Number(next.version);
    const end = await versionStop(routeId, Number(next.fromVersion), true);
    const start = await versionStop(nextId, nextVersion, false);
    let problem: string | null;
    try {
      if (!router) throw new Error("No router configured");
      const [leg] = await router([end.point, start.point]);
      const readyAt = end.minutes + end.serviceMinutes + leg.durationSeconds / 60;
      problem = readyAt <= start.minutes + 1e-6
        ? null
        : `The Chofer reaches the first Parada at ${clockOfSeconds(Math.ceil(readyAt * 60)).slice(0, 5)}, after its planned ${clockOfSeconds(Math.round(start.minutes * 60)).slice(0, 5)}`;
    } catch {
      problem = "Routing is unavailable: check this Recorrido by hand";
    }
    const warning = { routeId: nextId, version: nextVersion, fromRouteId: routeId, ok: problem === null, problem };
    await appendChange(db, actorId, "route", String(nextId), "cascade_revalidated", null, {
      version: nextVersion, fromRouteId: routeId, fromVersion: Number(next.fromVersion), ok: warning.ok, problem,
    });
    return [warning];
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
      const id = parseId(context.req.param("id"));
      if (!id || !isObject(body) || typeof body.password !== "string" || !body.password) {
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
      const id = parseId(context.req.param("id"));
      if (!id) return context.json({ error: "Invalid request" }, 400);
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
          `INSERT INTO destinations (name, kind, address, access_notes, latitude, longitude, arrival_tolerance_minutes)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${DESTINATION_COLUMNS}`,
          [destination.name, destination.kind, destination.address, destination.accessNotes, destination.lat, destination.lng,
            destination.arrivalToleranceMinutes],
        ) as QueryResult;
        const row = result.rows[0];
        await appendChange(client, actor.id, "destination", String(row.id), "created", null, destination);
        return row;
      });
      return context.json({ destination: created }, 201);
    })
    .patch("/destinations/:id", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const id = parseId(context.req.param("id"));
      const body = await context.req.json().catch(() => null);
      const tolerance = isObject(body) ? parseArrivalTolerance(body.arrivalToleranceMinutes) : null;
      if (!id || tolerance === null) return context.json({ error: "Invalid request" }, 400);
      const updated = await inTransaction(db, async (client) => {
        const before = await client.query(
          "SELECT arrival_tolerance_minutes FROM destinations WHERE id = $1 FOR UPDATE",
          [id],
        ) as QueryResult;
        if (!before.rows[0]) return null;
        const previous = Number(before.rows[0].arrival_tolerance_minutes);
        if (previous !== tolerance) {
          await client.query("UPDATE destinations SET arrival_tolerance_minutes = $1 WHERE id = $2", [tolerance, id]);
          await appendChange(client, actor.id, "destination", String(id), "updated", { arrivalToleranceMinutes: previous }, {
            arrivalToleranceMinutes: tolerance,
          });
        }
        return (await client.query(`SELECT ${DESTINATION_COLUMNS} FROM destinations WHERE id = $1`, [id]) as QueryResult).rows[0];
      });
      return updated ? context.json({ destination: updated }) : context.json({ error: "Destino not found" }, 404);
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
    .get("/passengers/:id/authorized-adults", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const id = parseId(context.req.param("id"));
      if (!id) return context.json({ error: "Invalid request" }, 400);
      const passenger = await db.query("SELECT id FROM passengers WHERE id = $1", [id]) as QueryResult;
      if (!passenger.rows[0]) return context.json({ error: "Passenger not found" }, 404);
      const adults = await db.query(`${AUTHORIZED_ADULT_SELECT_SQL} WHERE passenger_id = $1 ORDER BY lower(name), id`, [id]) as QueryResult;
      return context.json({ adults: adults.rows.map(formatAuthorizedAdult) });
    })
    .post("/passengers/:id/authorized-adults", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const id = parseId(context.req.param("id"));
      const fields = parseAuthorizedAdult(await context.req.json().catch(() => null));
      if (!id || !fields) return context.json({ error: "Invalid request" }, 400);
      const adult = await inTransaction(db, async (client) => {
        const passenger = await client.query("SELECT id FROM passengers WHERE id = $1 FOR SHARE", [id]) as QueryResult;
        if (!passenger.rows[0]) return null;
        const inserted = await client.query(
          `INSERT INTO authorized_adults (passenger_id, name, dni, relation, phone, legal_guardian)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [id, fields.name, fields.dni, fields.relation, fields.phone, fields.legalGuardian],
        ) as QueryResult;
        const adultId = Number(inserted.rows[0].id);
        await appendChange(client, actor.id, "authorized_adult", String(adultId), "created", null, { passengerId: id, ...fields });
        return { id: adultId, passengerId: id, ...fields };
      });
      return adult ? context.json({ adult }, 201) : context.json({ error: "Passenger not found" }, 404);
    })
    .patch("/authorized-adults/:id", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const id = parseId(context.req.param("id"));
      const fields = parseAuthorizedAdult(await context.req.json().catch(() => null));
      if (!id || !fields) return context.json({ error: "Invalid request" }, 400);
      try {
        const adult = await inTransaction(db, async (client) => {
          const locked = await client.query(`${AUTHORIZED_ADULT_SELECT_SQL} WHERE id = $1 FOR UPDATE`, [id]) as QueryResult;
          if (!locked.rows[0]) throw new PlanningError(404, "Adulto autorizado not found");
          const { id: _, passengerId, ...before } = formatAuthorizedAdult(locked.rows[0]);
          if (before.legalGuardian && !fields.legalGuardian && await signedConsent(client, id)) throw new PlanningError(409, SIGNER_MUST_STAY);
          await client.query(
            "UPDATE authorized_adults SET name = $1, dni = $2, relation = $3, phone = $4, legal_guardian = $5 WHERE id = $6",
            [fields.name, fields.dni, fields.relation, fields.phone, fields.legalGuardian, id],
          );
          await appendChange(client, actor.id, "authorized_adult", String(id), "updated", before, fields);
          return { id, passengerId, ...fields };
        });
        return context.json({ adult });
      } catch (error) {
        return planningFailure(context, error);
      }
    })
    .delete("/authorized-adults/:id", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const id = parseId(context.req.param("id"));
      if (!id) return context.json({ error: "Invalid request" }, 400);
      try {
        await inTransaction(db, async (client) => {
          const locked = await client.query(`${AUTHORIZED_ADULT_SELECT_SQL} WHERE id = $1 FOR UPDATE`, [id]) as QueryResult;
          if (!locked.rows[0]) throw new PlanningError(404, "Adulto autorizado not found");
          if (await signedConsent(client, id)) throw new PlanningError(409, SIGNER_MUST_STAY);
          await client.query("DELETE FROM authorized_adults WHERE id = $1", [id]);
          const { id: _, ...before } = formatAuthorizedAdult(locked.rows[0]);
          await appendChange(client, actor.id, "authorized_adult", String(id), "removed", before, null);
        });
        return context.body(null, 204);
      } catch (error) {
        return planningFailure(context, error);
      }
    })
    .get("/passengers/:id/consent", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const id = parseId(context.req.param("id"));
      if (!id) return context.json({ error: "Invalid request" }, 400);
      const passenger = await db.query("SELECT id FROM passengers WHERE id = $1", [id]) as QueryResult;
      if (!passenger.rows[0]) return context.json({ error: "Passenger not found" }, 404);
      return context.json({ consent: await getConsent(db, id) });
    })
    // Records or replaces the Pasajero's Consentimiento; the same values again change nothing and add no log entry.
    .post("/passengers/:id/consent", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const id = parseId(context.req.param("id"));
      const fields = parseConsent(await context.req.json().catch(() => null));
      if (!id || !fields) return context.json({ error: "Invalid request" }, 400);
      try {
        const result = await inTransaction(db, async (client) => {
          // Locking the Pasajero serialises two first recordings of the same Consentimiento.
          const passenger = await client.query("SELECT id FROM passengers WHERE id = $1 FOR UPDATE", [id]) as QueryResult;
          if (!passenger.rows[0]) throw new PlanningError(404, "Passenger not found");
          // FOR SHARE keeps the signer from losing the Responsable legal flag before this commits.
          const signer = await client.query(
            "SELECT legal_guardian FROM authorized_adults WHERE id = $1 AND passenger_id = $2 FOR SHARE",
            [fields.signedByAdultId, id],
          ) as QueryResult;
          if (signer.rows[0]?.legal_guardian !== true) {
            throw new PlanningError(409, "The Consentimiento must be signed by a Responsable legal of this Pasajero");
          }
          const current = await getConsent(client, id);
          const before = current && {
            signedByAdultId: current.signedByAdultId,
            signedAt: current.signedAt,
            otherAdultAllowed: current.otherAdultAllowed,
          };
          if (JSON.stringify(before) !== JSON.stringify(fields)) {
            await client.query(
              `INSERT INTO consents (passenger_id, signed_by_adult_id, signed_at, other_adult_allowed) VALUES ($1, $2, $3, $4)
               ON CONFLICT (passenger_id) DO UPDATE SET signed_by_adult_id = EXCLUDED.signed_by_adult_id, signed_at = EXCLUDED.signed_at,
                 other_adult_allowed = EXCLUDED.other_adult_allowed, recorded_at = now()`,
              [id, fields.signedByAdultId, fields.signedAt, fields.otherAdultAllowed],
            );
            await appendChange(client, actor.id, "consent", String(id), before ? "updated" : "recorded", before, fields);
          }
          return { created: before === null, consent: await getConsent(client, id) };
        });
        return context.json({ consent: result.consent }, result.created ? 201 : 200);
      } catch (error) {
        return planningFailure(context, error);
      }
    })
    // Creating the Plan diario of a date that already has one returns it unchanged.
    .post("/daily-plans", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const body = await context.req.json().catch(() => null);
      const date = isObject(body) ? parsePlanDate(body.date) : null;
      if (!date) return context.json({ error: "Invalid request" }, 400);
      const created = await inTransaction(db, async (client) => {
        const inserted = await client.query(
          "INSERT INTO daily_plans (plan_date) VALUES ($1) ON CONFLICT (plan_date) DO NOTHING RETURNING id",
          [date],
        ) as QueryResult;
        if (inserted.rows[0]) await appendChange(client, actor.id, "daily_plan", String(inserted.rows[0].id), "created", null, { date });
        return Boolean(inserted.rows[0]);
      });
      return context.json(await loadDailyPlan(db, date), created ? 201 : 200);
    })
    .get("/daily-plans/:date", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const date = parsePlanDate(context.req.param("date"));
      if (!date) return context.json({ error: "Invalid request" }, 400);
      const day = await loadDailyPlan(db, date);
      return day ? context.json(day) : context.json({ error: "Plan diario not found" }, 404);
    })
    .post("/daily-plans/:date/transfers", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const date = parsePlanDate(context.req.param("date"));
      const body = await context.req.json().catch(() => null);
      const fields = parseTransfer(body);
      if (!date || !fields) return context.json({ error: "Invalid request" }, 400);
      const exit = parseExitTime((body as Record<string, unknown>).exitTime, fields.originDestinationId, fields.targetTime);
      if ("error" in exit) return context.json({ error: exit.error }, 400);
      try {
        const transfer = await inTransaction(db, async (client) => {
          const planId = await findPlanId(client, date);
          // FOR SHARE keeps a concurrent deactivation from committing between this check and the insert.
          const passenger = await client.query(
            "SELECT companions, deactivated_at FROM passengers WHERE id = $1 FOR SHARE",
            [fields.passengerId],
          ) as QueryResult;
          const row = passenger.rows[0] as { companions: number; deactivated_at: string | null } | undefined;
          if (!row) throw new PlanningError(400, "Invalid request");
          if (row.deactivated_at !== null) throw new PlanningError(409, "A deactivated Pasajero cannot get new Traslados");
          const destinationIds = [fields.destinationId, ...(fields.originDestinationId ? [fields.originDestinationId] : [])];
          const destinations = await client.query("SELECT id FROM destinations WHERE id = ANY($1::int[])", [destinationIds]) as QueryResult;
          if (destinations.rows.length !== destinationIds.length) throw new PlanningError(400, "Invalid request");
          const values = { ...fields, exitTime: exit.exitTime, companions: fields.companions ?? Number(row.companions) };
          const inserted = await client.query(
            `INSERT INTO transfers (daily_plan_id, passenger_id, direction, destination_id, origin_destination_id, target_time, exit_time, companions)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [planId, values.passengerId, values.direction, values.destinationId, values.originDestinationId, values.targetTime, values.exitTime,
              values.companions],
          ) as QueryResult;
          const id = Number(inserted.rows[0].id);
          await appendChange(client, actor.id, "transfer", String(id), "created", null, { dailyPlanId: planId, ...values });
          return await getTransferById(client, id);
        });
        return context.json({ transfer }, 201);
      } catch (error) {
        return planningFailure(context, error);
      }
    })
    // Changes the Acompañantes or the exit time, and assigns, moves (routeId) or unassigns (routeId: null) the Traslado.
    .patch("/transfers/:id", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const id = parseId(context.req.param("id"));
      const body = await context.req.json().catch(() => null);
      if (!id || !isObject(body) || (body.companions === undefined && body.routeId === undefined && body.exitTime === undefined)) {
        return context.json({ error: "Invalid request" }, 400);
      }
      const companions = body.companions === undefined ? undefined : parseCompanions(body.companions);
      const targetRouteId = body.routeId === undefined ? undefined : body.routeId === null ? null : positiveInt(body.routeId);
      if (companions === null || (body.routeId !== null && targetRouteId === null)) return context.json({ error: "Invalid request" }, 400);
      try {
        const transfer = await inTransaction(db, async (client) => {
          const locked = await client.query(
            `SELECT t.daily_plan_id, t.status, t.companions, s.route_id, t.origin_destination_id,
                    to_char(t.target_time, 'HH24:MI') AS target_time, to_char(t.exit_time, 'HH24:MI') AS exit_time
               FROM transfers t LEFT JOIN stops s ON s.transfer_id = t.id AND s.kind = 'pickup'
              WHERE t.id = $1 FOR UPDATE OF t`,
            [id],
          ) as QueryResult;
          const row = locked.rows[0];
          if (!row) throw new PlanningError(404, "Traslado not found");
          const exit = body.exitTime === undefined ? null : parseExitTime(body.exitTime, row.origin_destination_id, String(row.target_time));
          if (exit && "error" in exit) throw new PlanningError(400, exit.error);
          const currentRouteId = nullableNumber(row.route_id);
          if (targetRouteId !== undefined && targetRouteId !== currentRouteId) {
            if (row.status !== "planificado") throw new PlanningError(409, "Only a Planificado Traslado can change Recorrido");
            if (targetRouteId !== null) await assertConsent(client, [id]);
            // Both Recorridos are locked in id order, so two opposite moves cannot deadlock.
            for (const routeId of [currentRouteId, targetRouteId].filter((value) => value !== null).sort((a, b) => a - b)) {
              const route = await lockRoute(client, routeId);
              if (route.dailyPlanId !== Number(row.daily_plan_id)) {
                throw new PlanningError(409, "The Recorrido belongs to another Plan diario");
              }
            }
            await removeStops(client, id);
            if (targetRouteId !== null) {
              await appendStops(client, targetRouteId, id);
              await settleStops(client, targetRouteId);
            }
            const action = currentRouteId === null ? "assigned" : targetRouteId === null ? "unassigned" : "moved";
            await appendChange(client, actor.id, "transfer", String(id), action, { routeId: currentRouteId }, { routeId: targetRouteId });
          }
          if (companions !== undefined && companions !== Number(row.companions)) {
            await client.query("UPDATE transfers SET companions = $1 WHERE id = $2", [companions, id]);
            await appendChange(client, actor.id, "transfer", String(id), "updated", { companions: Number(row.companions) }, { companions });
          }
          if (exit && "exitTime" in exit && exit.exitTime !== row.exit_time) {
            await client.query("UPDATE transfers SET exit_time = $1 WHERE id = $2", [exit.exitTime, id]);
            await appendChange(client, actor.id, "transfer", String(id), "updated", { exitTime: row.exit_time }, { exitTime: exit.exitTime });
          }
          return await getTransferById(client, id);
        });
        return context.json({ transfer });
      } catch (error) {
        return planningFailure(context, error);
      }
    })
    // A repeated Ausencia keeps the Traslado Cancelado por Ausencia without another log entry.
    .post("/transfers/:id/absence", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const id = parseId(context.req.param("id"));
      if (!id) return context.json({ error: "Invalid request" }, 400);
      try {
        const result = await inTransaction(db, async (client) => {
          const locked = await client.query("SELECT status FROM transfers WHERE id = $1 FOR UPDATE", [id]) as QueryResult;
          const status = locked.rows[0]?.status;
          if (!status) throw new PlanningError(404, "Traslado not found");
          if (status === "cancelado_ausencia") return { created: false, transfer: await getTransferById(client, id) };
          if (status !== "planificado") throw new PlanningError(409, "Only a Planificado Traslado can get an Ausencia");
          const assigned = await client.query("SELECT route_id FROM stops WHERE transfer_id = $1 LIMIT 1", [id]) as QueryResult;
          if (assigned.rows[0]) await lockRoute(client, Number(assigned.rows[0].route_id));
          await client.query("INSERT INTO absences (transfer_id, created_by) VALUES ($1, $2)", [id, actor.id]);
          const routeId = await removeStops(client, id);
          await client.query("UPDATE transfers SET status = 'cancelado_ausencia' WHERE id = $1", [id]);
          await appendChange(client, actor.id, "transfer", String(id), "absence_registered", { status, routeId }, {
            status: "cancelado_ausencia",
            routeId: null,
          });
          return { created: true, transfer: await getTransferById(client, id) };
        });
        return context.json({ transfer: result.transfer }, result.created ? 201 : 200);
      } catch (error) {
        return planningFailure(context, error);
      }
    })
    .post("/daily-plans/:date/routes", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const date = parsePlanDate(context.req.param("date"));
      const body = await context.req.json().catch(() => null);
      const driverId = isObject(body) ? positiveInt(body.driverId) : null;
      const startTime = isObject(body) ? parseLocalTime(body.startTime) : null;
      const endTime = isObject(body) ? parseLocalTime(body.endTime) : null;
      if (!date || !isObject(body) || !driverId || !startTime || !endTime || endTime < startTime) {
        return context.json({ error: "Invalid request" }, 400);
      }
      try {
        const route = await inTransaction(db, async (client) => {
          const planId = await findPlanId(client, date);
          const vehicleId = await chooseVehicle(client, driverId, body.vehicleId);
          const id = await insertRoute(client, actor.id, planId, { driverId, vehicleId, startTime, endTime });
          return await getRouteById(client, id);
        });
        return context.json({ route }, 201);
      } catch (error) {
        return planningFailure(context, error);
      }
    })
    .patch("/routes/:id", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const id = parseId(context.req.param("id"));
      const body = await context.req.json().catch(() => null);
      const vehicleId = isObject(body) && body.vehicleId !== undefined ? positiveInt(body.vehicleId) : undefined;
      const ends = isObject(body) ? parseRouteEnds(body) : null;
      if (!id || vehicleId === null || !ends || (vehicleId === undefined && !ends.start && ends.endKind === undefined)) {
        return context.json({ error: "Invalid request" }, 400);
      }
      try {
        const route = await inTransaction(db, async (client) => {
          await lockRoute(client, id);
          if (vehicleId !== undefined) await assertActiveUsualVehicle(client, vehicleId);
          const before: Record<string, unknown> = await getRouteById(client, id);
          const after: Record<string, unknown> = {
            vehicleId: vehicleId ?? before.vehicleId,
            startKind: ends.start ? ends.start.kind : before.startKind,
            startLat: ends.start ? ends.start.lat : before.startLat,
            startLng: ends.start ? ends.start.lng : before.startLng,
            endKind: ends.endKind !== undefined ? ends.endKind : before.endKind,
          };
          const changed = Object.keys(after).filter((key) => after[key] !== before[key]);
          if (changed.length) {
            await client.query(
              "UPDATE routes SET vehicle_id = $1, start_kind = $2, start_latitude = $3, start_longitude = $4, end_kind = $5 WHERE id = $6",
              [after.vehicleId, after.startKind, after.startLat, after.startLng, after.endKind, id],
            );
            await appendChange(
              client, actor.id, "route", String(id), "updated",
              Object.fromEntries(changed.map((key) => [key, before[key]])),
              Object.fromEntries(changed.map((key) => [key, after[key]])),
            );
          }
          return await getRouteById(client, id);
        });
        return context.json({ route });
      } catch (error) {
        return planningFailure(context, error);
      }
    })
    // "Order": the engine orders the Borrador Recorrido's Paradas and plans their times. Traslados it cannot place leave
    // the Recorrido with their reason, so every Traslado is in the order or in `unassigned`. The engine runs outside the
    // transaction; the result is applied only if neither the Recorrido nor the Chofer's Recorridos right before and after it
    // changed meanwhile.
    .post("/routes/:id/order", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const id = parseId(context.req.param("id"));
      if (!id) return context.json({ error: "Invalid request" }, 400);
      if (!solver || !travelTime) return context.json({ error: "The routing engine is not configured" }, 503);
      try {
        const { route, rows, neighbours, key } = await orderInputKey(db, id);
        if (!route) throw new PlanningError(404, "Recorrido not found");
        if (route.status !== "borrador") throw new PlanningError(409, "Only a Borrador Recorrido can be ordered");
        // Entradas from another Destino stored before the exit time existed cannot be planned until the Oficina sets it.
        const withoutExit = rows.filter((row) => row.o_lat !== null && row.exit_time === null);
        if (withoutExit.length) {
          const names = withoutExit.map((row) => `${row.name} (Traslado ${row.id})`).join(", ");
          throw new PlanningError(409, `Set the exit time from the first Destino of: ${names}`);
        }
        let plan: PlanResult = { stops: [], unassigned: [] };
        if (rows.length) {
          const ends = resolveRouteEnds(route, neighbours, routeGapMinutes);
          const startMinutes = minutesOf(String(route.start_time));
          try {
            // Not before the previous Recorrido's planned end plus the drive from its last Parada to where it ends
            // and from there to this start.
            let notBeforeMinutes = ends.previousEnd;
            if (notBeforeMinutes !== undefined && ends.previousStop && ends.previousEndPoint) {
              for (const [from, to] of [[ends.previousStop, ends.previousEndPoint], [ends.previousEndPoint, ends.start]]) {
                if (from[0] === to[0] && from[1] === to[1]) continue;
                const drive = await travelTime(from, to);
                notBeforeMinutes += Math.ceil(drive / 60 / speedFactorAt(plannerSettings.speedFactors, startMinutes));
              }
            }
            plan = await planRoute({
              transfers: rows.map(toPlanTransfer),
              vehicle: { seats: Number(route.seats), featureIds: (route.feature_ids as number[]).map(Number) },
              start: ends.start,
              end: ends.end,
              notBeforeMinutes,
              startMinutes,
            }, plannerSettings, solver);
          } catch {
            return context.json({ error: "The routing engine is unavailable: the order was not changed" }, 502);
          }
        }
        const stops = await inTransaction(db, async (client) => {
          // The neighbouring Recorridos are locked too, in id order, so none of them changes before this commits.
          const locked = [id, neighbours.previous?.id, neighbours.next?.id].filter((value) => value !== undefined).map(Number);
          await client.query("SELECT id FROM routes WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE", [locked]);
          await lockRoute(client, id);
          if ((await orderInputKey(client, id)).key !== key) {
            throw new PlanningError(409, "The Recorrido changed while it was being ordered: order it again");
          }
          const stopIds = async () => (await client.query("SELECT id FROM stops WHERE route_id = $1 ORDER BY position", [id]) as QueryResult)
            .rows.map((row) => Number(row.id));
          const before = await stopIds();
          for (const item of plan.unassigned) {
            await removeStops(client, item.transferId);
            await appendChange(client, actor.id, "transfer", String(item.transferId), "unassigned", { routeId: id }, {
              routeId: null,
              reason: item.reason,
            });
          }
          if (plan.stops.length) {
            await client.query(
              `UPDATE stops SET position = o.ord, planned_time = time '00:00' + o.seconds * interval '1 second', leg_distance_meters = o.meters
                 FROM unnest($2::int[], $3::text[], $4::int[], $5::int[]) WITH ORDINALITY AS o(transfer_id, kind, seconds, meters, ord)
                WHERE stops.route_id = $1 AND stops.transfer_id = o.transfer_id AND stops.kind = o.kind`,
              [id, plan.stops.map((stop) => stop.transferId), plan.stops.map((stop) => stop.kind),
                plan.stops.map((stop) => Math.round(stop.plannedSeconds)), plan.stops.map((stop) => stop.legDistanceMeters)],
            );
          }
          await appendChange(client, actor.id, "route", String(id), "ordered", { stopIds: before }, {
            stopIds: await stopIds(),
            unassigned: plan.unassigned,
          });
          return (await client.query(`${STOP_SELECT_SQL} WHERE s.route_id = $1 ORDER BY s.position`, [id]) as QueryResult).rows;
        });
        const names = new Map(rows.map((row) => [Number(row.id), String(row.name)]));
        return context.json({
          route: await getRouteById(db, id),
          stops: stops.map((row) => ({
            id: Number(row.id),
            transferId: Number(row.transferId),
            kind: row.kind,
            position: Number(row.position),
            plannedTime: row.plannedTime ?? null,
            legDistanceMeters: nullableNumber(row.legDistanceMeters),
            passengerName: row.passengerName,
            placeName: row.placeName ?? null,
          })),
          unassigned: plan.unassigned.map((item) => ({ ...item, passengerName: names.get(item.transferId) })),
          violations: validateOrder(rows, plan.stops, route),
        });
      } catch (error) {
        return planningFailure(context, error);
      }
    })
    // Manual order: the full list of the Recorrido's Paradas; a pickup after its own drop-off is refused.
    .patch("/routes/:id/stops", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const id = parseId(context.req.param("id"));
      const body = await context.req.json().catch(() => null);
      // parseFeatureIds checks the ids and drops repeats; the same length means none was repeated.
      const stopIds = isObject(body) ? parseFeatureIds(body.stopIds) : null;
      if (!id || !stopIds || !isObject(body) || !Array.isArray(body.stopIds) || stopIds.length !== body.stopIds.length) {
        return context.json({ error: "Invalid request" }, 400);
      }
      const order = body.stopIds as number[];
      try {
        await inTransaction(db, async (client) => {
          await lockRoute(client, id);
          const current = await client.query(
            "SELECT id, transfer_id, kind FROM stops WHERE route_id = $1 ORDER BY position",
            [id],
          ) as QueryResult;
          const byId = new Map(current.rows.map((row) => [Number(row.id), row]));
          if (order.length !== byId.size || order.some((stopId) => !byId.has(stopId))) {
            throw new PlanningError(400, "Send every Parada of the Recorrido exactly once");
          }
          const pickedUp = new Set<number>();
          for (const stopId of order) {
            const stop = byId.get(stopId)!;
            if (stop.kind === "pickup") pickedUp.add(Number(stop.transfer_id));
            else if (!pickedUp.has(Number(stop.transfer_id))) {
              throw new PlanningError(409, "A Pasajero's pickup must come before their drop-off");
            }
          }
          await client.query(
            "UPDATE stops SET position = o.ord FROM unnest($1::int[]) WITH ORDINALITY AS o(id, ord) WHERE stops.id = o.id",
            [order],
          );
          await settleStops(client, id);
          await appendChange(client, actor.id, "route", String(id), "stops_reordered", {
            stopIds: current.rows.map((row) => Number(row.id)),
          }, { stopIds: order });
        });
        return context.json({ stopIds: order });
      } catch (error) {
        return planningFailure(context, error);
      }
    })
    // The Chofer's whole day, as the planner writes it: Recorridos are cut where target times are more than
    // routeGapMinutes apart. Refused when the Chofer already has Recorridos that day, so a rerun never duplicates.
    .post("/daily-plans/:date/driver-days", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const date = parsePlanDate(context.req.param("date"));
      const body = await context.req.json().catch(() => null);
      const driverId = isObject(body) ? positiveInt(body.driverId) : null;
      const transferIds = isObject(body) ? parseFeatureIds(body.transferIds) : null;
      if (!date || !isObject(body) || !driverId || !transferIds?.length || !Array.isArray(body.transferIds)
        || transferIds.length !== body.transferIds.length) {
        return context.json({ error: "Invalid request" }, 400);
      }
      try {
        const created = await inTransaction(db, async (client) => {
          const planId = await findPlanId(client, date);
          const vehicleId = await chooseVehicle(client, driverId, body.vehicleId);
          const existing = await client.query(
            "SELECT 1 FROM routes WHERE daily_plan_id = $1 AND driver_id = $2 LIMIT 1",
            [planId, driverId],
          ) as QueryResult;
          if (existing.rows.length) throw new PlanningError(409, "This Chofer already has Recorridos on this day");
          const locked = await client.query(
            `SELECT t.id, t.daily_plan_id, t.status, to_char(t.target_time, 'HH24:MI') AS target,
                    EXISTS (SELECT 1 FROM stops s WHERE s.transfer_id = t.id) AS assigned
               FROM transfers t WHERE t.id = ANY($1::int[]) ORDER BY t.target_time, t.id FOR UPDATE`,
            [transferIds],
          ) as QueryResult;
          if (locked.rows.length !== transferIds.length) throw new PlanningError(400, "Invalid request");
          for (const row of locked.rows) {
            if (Number(row.daily_plan_id) !== planId) throw new PlanningError(409, "Every Traslado must belong to this Plan diario");
            if (row.status !== "planificado" || row.assigned) {
              throw new PlanningError(409, "Only Planificado Traslados without a Recorrido can be given to a Chofer");
            }
          }
          await assertConsent(client, transferIds);
          const segments: { id: number; target: string }[][] = [];
          for (const row of locked.rows) {
            const transfer = { id: Number(row.id), target: String(row.target) };
            const last = segments.at(-1)?.at(-1);
            if (!last || minutesOf(transfer.target) - minutesOf(last.target) > routeGapMinutes) segments.push([transfer]);
            else segments.at(-1)!.push(transfer);
          }
          const routes = [];
          for (const segment of segments) {
            const startTime = segment[0].target;
            const endTime = segment.at(-1)!.target;
            const routeId = await insertRoute(client, actor.id, planId, { driverId, vehicleId, startTime, endTime });
            for (const transfer of segment) {
              await appendStops(client, routeId, transfer.id);
              await appendChange(client, actor.id, "transfer", String(transfer.id), "assigned", { routeId: null }, { routeId });
            }
            routes.push({ id: routeId, startTime, endTime, transferIds: segment.map((transfer) => transfer.id) });
          }
          return routes;
        });
        return context.json({ routes: created }, 201);
      } catch (error) {
        return planningFailure(context, error);
      }
    })
    // Publishes one Recorrido as a new version each time; with violations only a non-empty overrideReason forces it
    // (never for a Traslado unserved).
    .post("/routes/:id/publish", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const id = parseId(context.req.param("id"));
      const body = await context.req.json().catch(() => null);
      const reason = isObject(body) ? body.overrideReason ?? null : undefined;
      if (!id || (reason !== null && (typeof reason !== "string" || reason.length > 1000))) {
        return context.json({ error: "Invalid request" }, 400);
      }
      try {
        const result = await publishRoute(actor.id, id, reason?.trim() || null);
        return context.json({ version: result.version, cascade: result.cascade }, 201);
      } catch (error) {
        return planningFailure(context, error);
      }
    })
    .get("/routes/:id/versions", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const id = parseId(context.req.param("id"));
      if (!id) return context.json({ error: "Invalid request" }, 400);
      const route = await db.query("SELECT id FROM routes WHERE id = $1", [id]) as QueryResult;
      if (!route.rows[0]) return context.json({ error: "Recorrido not found" }, 404);
      return context.json({ versions: await loadPlanVersions(db, "pv.route_id = $1", [id]) });
    })
    // Publishes every Recorrido of the day, each in its own transaction, without forcing; unchanged ones keep their version.
    .post("/daily-plans/:date/publish", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const date = parsePlanDate(context.req.param("date"));
      if (!date) return context.json({ error: "Invalid request" }, 400);
      try {
        const planId = await findPlanId(db, date);
        const routes = await db.query("SELECT id FROM routes WHERE daily_plan_id = $1 ORDER BY start_time, id", [planId]) as QueryResult;
        const summary = {
          published: [] as { routeId: number; version: number }[],
          unchanged: [] as number[],
          failed: [] as Record<string, unknown>[],
          cascade: [] as CascadeWarning[],
        };
        for (const row of routes.rows) {
          const routeId = Number(row.id);
          try {
            const result = await publishRoute(actor.id, routeId, null, true);
            if (result.created) summary.published.push({ routeId, version: result.version.version });
            else summary.unchanged.push(routeId);
            summary.cascade.push(...result.cascade);
          } catch (error) {
            if (!(error instanceof PlanningError)) throw error;
            summary.failed.push({ routeId, error: error.message, ...error.extra });
          }
        }
        return context.json(summary);
      } catch (error) {
        return planningFailure(context, error);
      }
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
