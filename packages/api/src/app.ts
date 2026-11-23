import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getCookie, deleteCookie, setCookie } from "hono/cookie";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import webpush from "web-push";
import {
  TRASBORDO_WINDOW_MINUTES, validateRoute, type RouteViolation, type ServerEpoch, type Stop as ValidatorStop, type Transfer as ValidatorTransfer,
} from "@traslado/shared";
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
import { canonicalIp, createTrustedProxies, forwardedClientIp } from "./trusted-proxies.js";
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
  // Proxies allowed to name the client in X-Forwarded-For; empty or unset trusts none.
  trustedProxyCidrs?: string[];
  now?: () => Date;
  // A Chofer's day is cut into Recorridos where two consecutive target times are further apart than this.
  routeGapMinutes?: number;
  planner?: PlannerSettings;
  // Where company staff receive a Pasajero nobody else can receive (`inferido`); null when not configured.
  baseAddress?: string | null;
  vapid?: {
    publicKey: string;
    privateKey: string;
    subject: string;
  } | null;
};

export type PushSubscriptionKeys = {
  p256dh: string;
  auth: string;
};

export type PushSubscriptionData = {
  endpoint: string;
  keys: PushSubscriptionKeys;
};

export type PushSender = (
  subscription: PushSubscriptionData,
  payload: string,
) => Promise<{ statusCode?: number } | void>;

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

function clientIp(context: Context, config: AppConfig, trustedProxies: ReturnType<typeof createTrustedProxies>) {
  if (config.getClientIp) return config.getClientIp(context);
  let socketAddress: string;
  try {
    socketAddress = getConnInfo(context).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
  return canonicalIp(trustedProxies ? forwardedClientIp(socketAddress, context.req.header("X-Forwarded-For"), trustedProxies) : socketAddress);
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

// Documents every new Vehículo or Chofer starts with, without a date; the Oficina may rename or remove them.
const VEHICLE_DOCUMENT_NAMES = ["VTV", "Service"];
const DRIVER_DOCUMENT_NAMES = ["Carnet de manejo", "Certificado de sanidad", "Certificado de buena conducta"];
// The Vencimientos panel lists a document from this many days before its date.
const EXPIRY_ALERT_DAYS = 30;
const LOCAL_TIME_ZONE = "America/Argentina/Tucuman";

type DocumentOwner = { kind: "vehicle" | "driver"; id: number };

/** Today's date in Tucumán, "YYYY-MM-DD": a document is valid through its date and expired from the next local day. */
function localDate(at: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: LOCAL_TIME_ZONE }).format(at);
}

// Only the name and the date are kept: any other field (a file, a scan, a photo) is refused.
function parseDocument(body: unknown): { name: string; expiresOn: string | null } | { error: string } {
  if (!isObject(body)) return { error: "Invalid request" };
  if (Object.keys(body).some((key) => key !== "name" && key !== "expiresOn")) {
    return { error: "Only a document's name and expiry date are stored" };
  }
  const name = boundedText(body.name, 200);
  if (!name) return { error: "Invalid name: write the document's name" };
  const raw = body.expiresOn ?? null;
  const expiresOn = raw === null ? null : parsePlanDate(raw);
  if (raw !== null && !expiresOn) return { error: "Invalid expiry date (expiresOn): use YYYY-MM-DD" };
  return { name, expiresOn };
}

const DOCUMENT_SELECT_SQL = `
  SELECT d.id, d.vehicle_id AS "vehicleId", d.driver_id AS "driverId", d.name, to_char(d.expires_on, 'YYYY-MM-DD') AS "expiresOn"
    FROM documents d`;

function formatDocument(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    vehicleId: nullableNumber(row.vehicleId),
    driverId: nullableNumber(row.driverId),
    name: String(row.name),
    expiresOn: (row.expiresOn as string | null) ?? null,
  };
}

async function seedDocuments(client: Queryable, actorId: number, owner: DocumentOwner) {
  const names = owner.kind === "vehicle" ? VEHICLE_DOCUMENT_NAMES : DRIVER_DOCUMENT_NAMES;
  const inserted = await client.query(
    `INSERT INTO documents (vehicle_id, driver_id, name) SELECT $1, $2, n.name FROM unnest($3::text[]) WITH ORDINALITY AS n(name, i)
     ORDER BY n.i RETURNING id, vehicle_id AS "vehicleId", driver_id AS "driverId", name, NULL AS "expiresOn"`,
    [owner.kind === "vehicle" ? owner.id : null, owner.kind === "driver" ? owner.id : null, names],
  ) as QueryResult;
  for (const row of inserted.rows) {
    const { id, ...after } = formatDocument(row);
    await appendChange(client, actorId, "document", String(id), "created", null, after);
  }
}

/** The expired documents of each Recorrido's Vehículo and Chofer on the Recorrido's day: a warning, never a refusal. */
async function expiredDocumentWarnings(client: Queryable, routeIds: number[]) {
  const result = await client.query(
    `SELECT r.id AS "routeId", d.name, to_char(d.expires_on, 'YYYY-MM-DD') AS "expiresOn",
            CASE WHEN d.vehicle_id IS NULL THEN 'driver' ELSE 'vehicle' END AS owner, COALESCE(v.plate, dr.name) AS "ownerLabel"
       FROM routes r JOIN daily_plans p ON p.id = r.daily_plan_id
       JOIN documents d ON d.vehicle_id = r.vehicle_id OR d.driver_id = r.driver_id
       LEFT JOIN vehicles v ON v.id = d.vehicle_id LEFT JOIN drivers dr ON dr.id = d.driver_id
      WHERE r.id = ANY($1::int[]) AND d.expires_on < p.plan_date
      ORDER BY r.id, d.vehicle_id IS NULL, d.expires_on, d.id`,
    [routeIds],
  ) as QueryResult;
  return result.rows.map((row) => {
    const owner = row.owner === "vehicle" ? "vehicle" as const : "driver" as const;
    return {
      routeId: Number(row.routeId),
      owner,
      ownerLabel: String(row.ownerLabel),
      document: String(row.name),
      expiresOn: String(row.expiresOn),
      message: `${owner === "vehicle" ? "Vehículo" : "Chofer"} ${row.ownerLabel}: ${row.name} expired on ${row.expiresOn}`,
    };
  });
}

/** The expiry warnings read after the write committed: a failed read degrades to warningsUnavailable, never a failed write. */
async function warningsAfterCommit(client: Queryable, routeIds: number[]) {
  try {
    return { warnings: await expiredDocumentWarnings(client, routeIds) };
  } catch {
    return { warnings: [], warningsUnavailable: true };
  }
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
  constructor(readonly status: 400 | 403 | 404 | 409 | 502, message: string, readonly extra: Record<string, unknown> = {}) {
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

// A leg that started at a Trasbordo and was handed over again (a chain of three or more legs) ends where its next leg
// starts: its drop-off is a Trasbordo end at that leg's point and time. Joins that next leg as `nx` of the transfers row `t`.
const NEXT_LEG_JOIN_SQL = "LEFT JOIN transfers nx ON nx.chained_from_transfer_id = t.id AND t.trasbordo_stop = 'pickup'";

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
    s.route_id AS "routeId",
    t.chained_from_transfer_id AS "chainedFromTransferId",
    (SELECT n.id FROM transfers n WHERE n.chained_from_transfer_id = t.id) AS "chainedToTransferId",
    t.trasbordo_stop AS "trasbordoStop",
    t.trasbordo_latitude AS "trasbordoLat",
    t.trasbordo_longitude AS "trasbordoLng",
    to_char(t.trasbordo_time, 'HH24:MI') AS "trasbordoTime"
  FROM transfers t
  JOIN passengers p ON p.id = t.passenger_id
  JOIN destinations d ON d.id = t.destination_id
  LEFT JOIN destinations o ON o.id = t.origin_destination_id
  LEFT JOIN stops s ON s.transfer_id = t.id AND s.kind = 'pickup'
`;

function nullableNumber(value: unknown) {
  return value === null || value === undefined ? null : Number(value);
}

// A leg of a Trasbordo names the leg before (chainedFrom) or after it (chainedTo); trasbordo is its end at the point.
function formatTransferRow({ trasbordoStop, trasbordoLat, trasbordoLng, trasbordoTime, ...row }: Record<string, unknown>) {
  return {
    ...row,
    chainedFromTransferId: nullableNumber(row.chainedFromTransferId),
    chainedToTransferId: nullableNumber(row.chainedToTransferId),
    trasbordo: trasbordoStop === null || trasbordoStop === undefined
      ? null
      : { stop: String(trasbordoStop), lat: Number(trasbordoLat), lng: Number(trasbordoLng), time: String(trasbordoTime) },
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
      WHEN s.kind = t.trasbordo_stop OR (s.kind = 'dropoff' AND nx.id IS NOT NULL) THEN 'Trasbordo'
      WHEN s.kind = 'pickup' AND t.direction = 'entrada' THEN o.name
      WHEN s.kind = 'pickup' OR t.direction = 'entrada' THEN d.name
    END AS "placeName"
  FROM stops s
  JOIN transfers t ON t.id = s.transfer_id
  JOIN passengers p ON p.id = t.passenger_id
  JOIN destinations d ON d.id = t.destination_id
  LEFT JOIN destinations o ON o.id = t.origin_destination_id
  ${NEXT_LEG_JOIN_SQL}
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

function addDays(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function copyFromLastWeekday(client: Queryable, actorId: number, targetDate: string) {
  const existingTarget = await client.query(
    "SELECT id FROM daily_plans WHERE plan_date = $1",
    [targetDate],
  ) as QueryResult;
  let targetPlanId: number;

  if (existingTarget.rows[0]) {
    targetPlanId = Number(existingTarget.rows[0].id);
    const existingTransfers = await client.query(
      "SELECT 1 FROM transfers WHERE daily_plan_id = $1 LIMIT 1",
      [targetPlanId],
    ) as QueryResult;
    if (existingTransfers.rows[0]) {
      throw new PlanningError(409, "Copying into a day that already has Traslados is refused");
    }
  } else {
    const inserted = await client.query(
      "INSERT INTO daily_plans (plan_date) VALUES ($1) RETURNING id",
      [targetDate],
    ) as QueryResult;
    targetPlanId = Number(inserted.rows[0].id);
    await appendChange(client, actorId, "daily_plan", String(targetPlanId), "created", null, { date: targetDate });
  }

  // Find the last same weekday with a plan (up to 4 weeks back)
  const candidateDates = [-7, -14, -21, -28].map((days) => addDays(targetDate, days));
  let sourcePlan: { id: number; date: string } | null = null;

  for (const date of candidateDates) {
    const res = await client.query(
      `SELECT dp.id, to_char(dp.plan_date, 'YYYY-MM-DD') AS date
         FROM daily_plans dp
        WHERE dp.plan_date = $1`,
      [date],
    ) as QueryResult;
    if (res.rows[0]) {
      sourcePlan = { id: Number(res.rows[0].id), date: String(res.rows[0].date) };
      break;
    }
  }

  if (!sourcePlan) {
    throw new PlanningError(404, "No plan found on the last same weekdays");
  }

  const sourcePlanId = sourcePlan.id;
  const sourceDate = sourcePlan.date;

  // Source transfers
  const sourceTransfersRes = await client.query(
    `SELECT t.id, t.passenger_id, t.direction, t.destination_id, t.origin_destination_id,
            to_char(t.target_time, 'HH24:MI') AS target_time,
            to_char(t.exit_time, 'HH24:MI') AS exit_time,
            t.companions, t.chained_from_transfer_id, t.trasbordo_stop,
            t.trasbordo_latitude, t.trasbordo_longitude,
            to_char(t.trasbordo_time, 'HH24:MI') AS trasbordo_time,
            p.name AS passenger_name, p.deactivated_at
       FROM transfers t
       JOIN passengers p ON p.id = t.passenger_id
      WHERE t.daily_plan_id = $1
      ORDER BY t.chained_from_transfer_id NULLS FIRST, t.id`,
    [sourcePlanId],
  ) as QueryResult;

  const deactivatedPassengersMap = new Map<number, string>();
  for (const row of sourceTransfersRes.rows) {
    if (row.deactivated_at !== null) {
      deactivatedPassengersMap.set(Number(row.passenger_id), String(row.passenger_name));
    }
  }
  const skippedPassengers = Array.from(deactivatedPassengersMap.entries()).map(([id, name]) => ({ id, name }));

  // Source routes
  const sourceRoutesRes = await client.query(
    `SELECT r.id, r.driver_id, r.vehicle_id,
            to_char(r.start_time, 'HH24:MI') AS start_time,
            to_char(r.end_time, 'HH24:MI') AS end_time,
            r.start_kind, r.start_latitude, r.start_longitude, r.end_kind
       FROM routes r
      WHERE r.daily_plan_id = $1
      ORDER BY r.id`,
    [sourcePlanId],
  ) as QueryResult;

  // Source stops
  const sourceStopsRes = await client.query(
    `SELECT s.id, s.route_id, s.transfer_id, s.kind, s.position, s.leg_distance_meters,
            to_char(s.planned_time, 'HH24:MI') AS planned_time
       FROM stops s
       JOIN routes r ON r.id = s.route_id
      WHERE r.daily_plan_id = $1
      ORDER BY s.route_id, s.position`,
    [sourcePlanId],
  ) as QueryResult;

  // Copy routes (always Borrador, keeps driver and vehicle)
  const oldRouteIdToNewRouteId = new Map<number, number>();
  for (const route of sourceRoutesRes.rows) {
    const inserted = await client.query(
      `INSERT INTO routes (daily_plan_id, driver_id, vehicle_id, start_time, end_time, status, start_kind, start_latitude, start_longitude, end_kind)
       VALUES ($1, $2, $3, $4, $5, 'borrador', $6, $7, $8, $9)
       RETURNING id`,
      [
        targetPlanId,
        route.driver_id,
        route.vehicle_id,
        route.start_time,
        route.end_time,
        route.start_kind,
        route.start_latitude,
        route.start_longitude,
        route.end_kind,
      ],
    ) as QueryResult;
    const newRouteId = Number(inserted.rows[0].id);
    oldRouteIdToNewRouteId.set(Number(route.id), newRouteId);
    await appendChange(client, actorId, "route", String(newRouteId), "created", null, {
      dailyPlanId: targetPlanId,
      driverId: Number(route.driver_id),
      vehicleId: Number(route.vehicle_id),
      startTime: String(route.start_time),
      endTime: String(route.end_time),
      status: "borrador",
      startKind: route.start_kind,
      startLatitude: route.start_latitude,
      startLongitude: route.start_longitude,
      endKind: route.end_kind,
    });
  }

  // Copy active transfers (Ausencias are NOT copied -> status is 'planificado')
  const oldTransferIdToNewTransferId = new Map<number, number>();
  for (const transfer of sourceTransfersRes.rows) {
    if (deactivatedPassengersMap.has(Number(transfer.passenger_id))) {
      continue;
    }
    const chainedFrom = transfer.chained_from_transfer_id
      ? oldTransferIdToNewTransferId.get(Number(transfer.chained_from_transfer_id)) ?? null
      : null;

    const inserted = await client.query(
      `INSERT INTO transfers (
        daily_plan_id, passenger_id, direction, destination_id, origin_destination_id,
        target_time, exit_time, companions, status,
        chained_from_transfer_id, trasbordo_stop, trasbordo_latitude, trasbordo_longitude, trasbordo_time
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'planificado', $9, $10, $11, $12, $13)
      RETURNING id`,
      [
        targetPlanId,
        transfer.passenger_id,
        transfer.direction,
        transfer.destination_id,
        transfer.origin_destination_id,
        transfer.target_time,
        transfer.exit_time,
        transfer.companions,
        chainedFrom,
        transfer.trasbordo_stop,
        transfer.trasbordo_latitude,
        transfer.trasbordo_longitude,
        transfer.trasbordo_time,
      ],
    ) as QueryResult;
    const newTransferId = Number(inserted.rows[0].id);
    oldTransferIdToNewTransferId.set(Number(transfer.id), newTransferId);
    await appendChange(client, actorId, "transfer", String(newTransferId), "created", null, {
      dailyPlanId: targetPlanId,
      passengerId: Number(transfer.passenger_id),
      direction: String(transfer.direction),
      destinationId: Number(transfer.destination_id),
      targetTime: String(transfer.target_time),
      status: "planificado",
    });
  }

  // Copy stops in order (skip stops of deactivated passengers)
  for (const route of sourceRoutesRes.rows) {
    const newRouteId = oldRouteIdToNewRouteId.get(Number(route.id))!;
    const routeStops = sourceStopsRes.rows
      .filter((s) => Number(s.route_id) === Number(route.id))
      .filter((s) => oldTransferIdToNewTransferId.has(Number(s.transfer_id)));

    for (let i = 0; i < routeStops.length; i++) {
      const stop = routeStops[i];
      const newTransferId = oldTransferIdToNewTransferId.get(Number(stop.transfer_id))!;
      const newPosition = i + 1;

      await client.query(
        `INSERT INTO stops (route_id, transfer_id, kind, position, leg_distance_meters, planned_time)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [newRouteId, newTransferId, stop.kind, newPosition, stop.leg_distance_meters, stop.planned_time],
      );

      if (stop.kind === "pickup") {
        await appendChange(client, actorId, "transfer", String(newTransferId), "assigned", { routeId: null }, { routeId: newRouteId });
      }
    }
  }

  // Log copy action on daily plan
  await appendChange(client, actorId, "daily_plan", String(targetPlanId), "copied_from_weekday", null, {
    fromDate: sourceDate,
    skippedPassengers,
  });

  return {
    copiedFromDate: sourceDate,
    skippedPassengers,
    day: await loadDailyPlan(client, targetDate),
  };
}

async function loadDailyPlanPrint(client: Queryable, date: string) {
  const planResult = await client.query(
    "SELECT id, to_char(plan_date, 'YYYY-MM-DD') AS date, time_zone AS \"timeZone\" FROM daily_plans WHERE plan_date = $1",
    [date],
  ) as QueryResult;
  const plan = planResult.rows[0];
  if (!plan) return null;
  const planId = Number(plan.id);

  // A Traslado has a published Recorrido when the latest version of its current Recorrido serves it.
  const unpublished = await client.query(
    `SELECT t.id, t.direction, to_char(t.target_time, 'HH24:MI') AS target_time,
            p.name AS passenger_name, d.name AS destination_name
       FROM transfers t
       JOIN passengers p ON p.id = t.passenger_id
       JOIN destinations d ON d.id = t.destination_id
       LEFT JOIN stops s ON s.transfer_id = t.id AND s.kind = 'pickup'
      WHERE t.daily_plan_id = $1 AND t.status <> 'cancelado_ausencia'
        AND NOT EXISTS (
          SELECT 1 FROM plan_version_transfers pvt JOIN plan_versions pv ON pv.id = pvt.plan_version_id
           WHERE pvt.transfer_id = t.id AND pv.route_id = s.route_id
             AND pv.version = (SELECT max(version) FROM plan_versions latest WHERE latest.route_id = s.route_id))
      ORDER BY t.target_time, t.id`,
    [planId],
  ) as QueryResult;

  if (unpublished.rows.length > 0) {
    return {
      status: 409 as const,
      error: "The Plan diario cannot be printed: some Traslados have no published Recorrido",
      unpublishedTransfers: unpublished.rows.map((row) => ({
        id: Number(row.id),
        passengerName: String(row.passenger_name),
        direction: String(row.direction),
        destinationName: String(row.destination_name),
        targetTime: String(row.target_time),
        label: `${row.target_time} ${row.passenger_name}: ${row.direction} → ${row.destination_name}`,
      })),
    };
  }

  const versions = await client.query(
    `SELECT DISTINCT ON (pv.route_id)
            pv.id, pv.route_id AS "routeId", pv.version,
            to_char(pv.start_time, 'HH24:MI') AS "startTime",
            to_char(pv.end_time, 'HH24:MI') AS "endTime",
            pv.published_at AS "publishedAt",
            dr.id AS "driverId", dr.name AS "driverName",
            v.id AS "vehicleId", v.plate AS "vehiclePlate", v.model AS "vehicleModel"
       FROM plan_versions pv
       JOIN routes r ON r.id = pv.route_id
       JOIN daily_plans dp ON dp.id = r.daily_plan_id
       JOIN drivers dr ON dr.id = pv.driver_id
       JOIN vehicles v ON v.id = pv.vehicle_id
      WHERE dp.id = $1
      ORDER BY pv.route_id, pv.version DESC`,
    [planId],
  ) as QueryResult;

  if (versions.rows.length === 0) {
    return {
      status: 200 as const,
      data: {
        plan: { date: String(plan.date), timeZone: String(plan.timeZone) },
        routes: [],
      },
    };
  }

  const versionIds = versions.rows.map((row) => Number(row.id));
  const legs = await client.query(
    `SELECT l.plan_version_id, l.position, l.kind, to_char(l.planned_time, 'HH24:MI') AS planned_time, l.transfer_id, t.direction,
            t.status, t.destination_id, t.origin_destination_id, pvt.companions, p.name, p.home_address, p.access_notes AS home_notes, p.wheelchair, p.medical_alert,
            CASE WHEN l.kind = 'dropoff' AND nx.id IS NOT NULL THEN 'dropoff' ELSE t.trasbordo_stop END AS trasbordo_stop,
            CASE WHEN l.kind = 'dropoff' AND nx.id IS NOT NULL THEN nx.trasbordo_latitude ELSE t.trasbordo_latitude END AS trasbordo_latitude,
            CASE WHEN l.kind = 'dropoff' AND nx.id IS NOT NULL THEN nx.trasbordo_longitude ELSE t.trasbordo_longitude END AS trasbordo_longitude,
            d.name AS d_name, d.address AS d_address, d.access_notes AS d_notes,
            o.name AS o_name, o.address AS o_address, o.access_notes AS o_notes
       FROM plan_version_legs l
       JOIN plan_version_transfers pvt ON pvt.plan_version_id = l.plan_version_id AND pvt.transfer_id = l.transfer_id
       JOIN transfers t ON t.id = l.transfer_id
       JOIN passengers p ON p.id = t.passenger_id
       JOIN destinations d ON d.id = t.destination_id
       LEFT JOIN destinations o ON o.id = t.origin_destination_id
       ${NEXT_LEG_JOIN_SQL}
      WHERE l.plan_version_id = ANY($1::int[])
      ORDER BY l.plan_version_id, l.position`,
    [versionIds],
  ) as QueryResult;

  const sortedVersions = [...versions.rows].sort((a, b) => {
    const timeCmp = String(a.startTime).localeCompare(String(b.startTime));
    return timeCmp !== 0 ? timeCmp : Number(a.routeId) - Number(b.routeId);
  });

  const routes = sortedVersions.map((row) => {
    const routeLegs = legs.rows.filter((l) => Number(l.plan_version_id) === Number(row.id));
    const stops = routeLegs.map((leg) => {
      const isTrasbordo = leg.trasbordo_stop === leg.kind;
      const prefix = leg.kind === "pickup"
        ? (leg.direction === "entrada" ? (leg.o_name === null ? null : "o") : "d")
        : (leg.direction === "entrada" ? "d" : null);

      const placeName = isTrasbordo
        ? "Trasbordo"
        : prefix === null
        ? "Domicilio"
        : String(leg[`${prefix}_name`]);

      const address = isTrasbordo
        ? `${leg.trasbordo_latitude}, ${leg.trasbordo_longitude}`
        : prefix === null
        ? String(leg.home_address)
        : String(leg[`${prefix}_address`]);

      const placeAccessNotes = isTrasbordo
        ? null
        : prefix === null
        ? (leg.home_notes as string | null) ?? null
        : (leg[`${prefix}_notes`] as string | null) ?? null;

      const passengerAccessNotes = (leg.home_notes as string | null) ?? null;
      const accessNotes = [placeAccessNotes, passengerAccessNotes !== placeAccessNotes ? passengerAccessNotes : null]
        .filter(Boolean)
        .join(" / ") || null;

      return {
        position: Number(leg.position),
        kind: String(leg.kind) as "pickup" | "dropoff",
        plannedTime: String(leg.planned_time),
        transferId: Number(leg.transfer_id),
        direction: String(leg.direction),
        passengerName: String(leg.name),
        companions: Number(leg.companions),
        wheelchair: Boolean(leg.wheelchair),
        medicalAlert: (leg.medical_alert as string | null) ?? null,
        accessNotes,
        passengerAccessNotes,
        placeAccessNotes,
        destinationName: String(leg.d_name),
        placeName,
        address,
      };
    });

    return {
      routeId: Number(row.routeId),
      version: Number(row.version),
      publishedAt: new Date(String(row.publishedAt)).toISOString(),
      startTime: String(row.startTime),
      endTime: String(row.endTime),
      driver: {
        id: Number(row.driverId),
        name: String(row.driverName),
      },
      vehicle: {
        id: Number(row.vehicleId),
        plate: String(row.vehiclePlate),
        model: String(row.vehicleModel),
      },
      stops,
    };
  });

  return {
    status: 200 as const,
    data: {
      plan: { date: String(plan.date), timeZone: String(plan.timeZone) },
      routes,
    },
  };
}

export const ROUTE_COLORS = [
  "#2e5aa8",
  "#bf4520",
  "#1b998b",
  "#7209b7",
  "#d90429",
  "#2a9d8f",
  "#e76f51",
  "#4361ee",
  "#38b000",
  "#7b2cbf",
];

export type LiveStop = {
  id: number;
  position: number;
  kind: "pickup" | "dropoff";
  passengerId: number;
  passengerName: string;
  placeName: string;
  latitude: number;
  longitude: number;
  plannedTime: string;
  eta: string | null;
  status: string;
  completed: boolean;
};

export type LiveLastMarca = {
  id: number;
  kind: string;
  latitude: number | null;
  longitude: number | null;
  phoneTime: string;
  phoneTimeHhmi: string;
};

export type LiveNextStop = {
  id: number;
  position: number;
  kind: "pickup" | "dropoff";
  passengerName: string;
  placeName: string;
  plannedTime: string;
  eta: string | null;
};

export type LiveRoute = {
  id: number;
  status: string;
  driver: { id: number; name: string };
  vehicle: { id: number; plate: string };
  color: string;
  childrenOnBoard: number;
  lastMarca: LiveLastMarca | null;
  stops: LiveStop[];
  nextStop: LiveNextStop | null;
  geometry: [number, number][];
};

export type LiveDailyPlan = {
  date: string;
  timeZone: string;
  routes: LiveRoute[];
};

async function loadLiveDailyPlan(client: Queryable, router: Router | undefined, date: string): Promise<LiveDailyPlan | null> {
  const planResult = await client.query(
    "SELECT id, to_char(plan_date, 'YYYY-MM-DD') AS date, time_zone AS \"timeZone\" FROM daily_plans WHERE plan_date = $1",
    [date],
  ) as QueryResult;
  const plan = planResult.rows[0];
  if (!plan) return null;
  const planId = Number(plan.id);

  const routesResult = await client.query(
    `${ROUTE_SELECT_SQL} WHERE r.daily_plan_id = $1 ORDER BY r.start_time, r.id`,
    [planId],
  ) as QueryResult;

  const clock = (minutes: number) => clockOfSeconds(Math.round(minutes * 60)).slice(0, 5);

  const routes: LiveRoute[] = [];
  for (let rIndex = 0; rIndex < routesResult.rows.length; rIndex++) {
    const rRow = routesResult.rows[rIndex];
    const routeId = Number(rRow.id);

    const stopsResult = await client.query(
      `SELECT
         s.id,
         s.route_id AS "routeId",
         s.transfer_id AS "transferId",
         s.kind,
         s.position,
         to_char(COALESCE(s.planned_time, pvl.planned_time), 'HH24:MI') AS "plannedTime",
         p.id AS "passengerId",
         p.name AS "passengerName",
         t.status AS "transferStatus",
         t.direction,
         ${stopPointSql("s.kind")},
         CASE
           WHEN s.kind = t.trasbordo_stop OR (s.kind = 'dropoff' AND nx.id IS NOT NULL) THEN 'Trasbordo'
           WHEN s.kind = 'pickup' AND t.direction = 'entrada' THEN COALESCE(o.name, p.home_address)
           WHEN s.kind = 'pickup' AND t.direction = 'salida' THEN d.name
           WHEN s.kind = 'dropoff' AND t.direction = 'entrada' THEN d.name
           WHEN s.kind = 'dropoff' AND t.direction = 'salida' THEN p.home_address
           ELSE d.name
         END AS "placeName"
       FROM stops s
       ${TRANSFER_PLACES_SQL}
       LEFT JOIN (
         SELECT DISTINCT ON (pv.route_id) pv.id, pv.route_id
           FROM plan_versions pv
          ORDER BY pv.route_id, pv.version DESC
       ) latest_pv ON latest_pv.route_id = s.route_id
       LEFT JOIN plan_version_legs pvl ON pvl.plan_version_id = latest_pv.id AND pvl.transfer_id = s.transfer_id AND pvl.kind = s.kind
       WHERE s.route_id = $1
       ORDER BY s.position, s.id`,
      [routeId],
    ) as QueryResult;

    const onBoardTransfers = new Set(
      stopsResult.rows.filter((row) => row.transferStatus === "subio").map((row) => Number(row.transferId)),
    );
    const childrenOnBoard = onBoardTransfers.size;

    const rawStops = stopsResult.rows.map((row) => {
      const isDone = isDoneStop(String(row.kind), String(row.transferStatus));
      const isVoided = String(row.kind) === "dropoff" && String(row.transferStatus) === "ausente";
      const statusStr = isDone
        ? (row.kind === "pickup" ? (row.transferStatus === "ausente" ? "ausente" : "subio") : String(row.transferStatus))
        : (isVoided ? "ausente" : "pending");
      return {
        id: Number(row.id),
        position: Number(row.position),
        transferId: Number(row.transferId),
        kind: String(row.kind) as "pickup" | "dropoff",
        passengerId: Number(row.passengerId),
        passengerName: String(row.passengerName),
        placeName: String(row.placeName ?? ""),
        latitude: Number(row.lat),
        longitude: Number(row.lng),
        plannedTime: (row.plannedTime as string | null) ?? "",
        serviceMinutes: Number(row.serviceMinutes ?? 5),
        transferStatus: String(row.transferStatus),
        completed: isDone || isVoided,
        status: statusStr,
        eta: null as string | null,
      };
    });

    const markResult = await client.query(
      `SELECT e.id, e.kind, e.latitude, e.longitude,
              to_char(e.phone_time AT TIME ZONE '${LOCAL_TIME_ZONE}', 'HH24:MI') AS phone_time_hhmi,
              EXTRACT(EPOCH FROM (e.phone_time AT TIME ZONE '${LOCAL_TIME_ZONE}')::time) / 60 AS phone_minutes,
              e.phone_time
         FROM marks e
         JOIN plan_versions pv ON pv.id = e.plan_version_id
        WHERE pv.route_id = $1
          AND ${MARK_IN_FORCE_SQL}
        ORDER BY e.phone_time DESC, e.id DESC
        LIMIT 1`,
      [routeId],
    ) as QueryResult;

    const lastMarcaRow = markResult.rows[0];
    let lastMarca: LiveLastMarca | null = null;
    if (lastMarcaRow) {
      const lat = lastMarcaRow.latitude !== null && lastMarcaRow.latitude !== undefined
        ? Number(lastMarcaRow.latitude)
        : null;
      const lng = lastMarcaRow.longitude !== null && lastMarcaRow.longitude !== undefined
        ? Number(lastMarcaRow.longitude)
        : null;
      lastMarca = {
        id: Number(lastMarcaRow.id),
        kind: String(lastMarcaRow.kind),
        latitude: lat,
        longitude: lng,
        phoneTime: new Date(String(lastMarcaRow.phone_time)).toISOString(),
        phoneTimeHhmi: String(lastMarcaRow.phone_time_hhmi),
      };
    }

    const remainingStops = rawStops.filter((s) => !s.completed);
    let nextStop: LiveNextStop | null = null;

    // Regla 2: A Recorrido without Marcas shows planned times, not ETAs
    if (!lastMarca) {
      if (remainingStops.length > 0) {
        nextStop = {
          id: remainingStops[0].id,
          position: remainingStops[0].position,
          kind: remainingStops[0].kind,
          passengerName: remainingStops[0].passengerName,
          placeName: remainingStops[0].placeName,
          plannedTime: remainingStops[0].plannedTime,
          eta: null,
        };
      }
    } else {
      if (remainingStops.length > 0) {
        if (lastMarca.latitude !== null && lastMarca.longitude !== null && router) {
          try {
            const points = [
              { lat: lastMarca.latitude, lng: lastMarca.longitude },
              ...remainingStops.map((s) => ({ lat: s.latitude, lng: s.longitude })),
            ];
            const legs = await router(points);
            let currentMinutes = Number(lastMarcaRow.phone_minutes);
            for (let i = 0; i < remainingStops.length; i++) {
              const legSeconds = legs[i]?.durationSeconds ?? 0;
              const travelMinutes = legSeconds / 60;
              const arrivalMinutes = currentMinutes + travelMinutes;
              remainingStops[i].eta = clock(arrivalMinutes);
              currentMinutes = arrivalMinutes + remainingStops[i].serviceMinutes;
            }
          } catch {
            for (const stop of remainingStops) {
              stop.eta = null;
            }
          }
        } else {
          for (const stop of remainingStops) {
            stop.eta = null;
          }
        }
        nextStop = {
          id: remainingStops[0].id,
          position: remainingStops[0].position,
          kind: remainingStops[0].kind,
          passengerName: remainingStops[0].passengerName,
          placeName: remainingStops[0].placeName,
          plannedTime: remainingStops[0].plannedTime,
          eta: remainingStops[0].eta,
        };
      }
    }

    const color = ROUTE_COLORS[rIndex % ROUTE_COLORS.length];

    const geometry: [number, number][] = [];
    if (rRow.startLat !== null && rRow.startLng !== null) {
      geometry.push([Number(rRow.startLng), Number(rRow.startLat)]);
    }
    for (const stop of rawStops) {
      geometry.push([stop.longitude, stop.latitude]);
    }

    const stops: LiveStop[] = rawStops.map(({ transferId: _, serviceMinutes: __, transferStatus: ___, ...stop }) => stop);

    routes.push({
      id: routeId,
      status: String(rRow.status),
      driver: { id: Number(rRow.driverId), name: String(rRow.driverName) },
      vehicle: { id: Number(rRow.vehicleId), plate: String(rRow.vehiclePlate) },
      color,
      childrenOnBoard,
      lastMarca,
      stops,
      nextStop,
      geometry,
    });
  }

  return {
    date: String(plan.date),
    timeZone: String(plan.timeZone),
    routes,
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

/**
 * The new Chofer of an existing Recorrido, refused once the Recorrido is En curso or Cerrado, for a deactivated account,
 * or when the Chofer already has another Recorrido of the day overlapping its time band. The Chofer is locked as when
 * a Recorrido is created, so two changes cannot both pass the overlap check.
 */
async function assertCanChangeDriver(client: Queryable, route: Record<string, unknown>, driverId: number) {
  if (route.status === "en_curso" || route.status === "cerrado") {
    throw new PlanningError(409, "A Recorrido En curso or Cerrado cannot change Chofer");
  }
  const driver = await client.query(
    "SELECT u.disabled_at FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.id = $1 FOR UPDATE OF d",
    [driverId],
  ) as QueryResult;
  if (!driver.rows[0]) throw new PlanningError(400, "Invalid request");
  if (driver.rows[0].disabled_at !== null) throw new PlanningError(409, "This Chofer is deactivated: choose another one");
  const overlap = await client.query(
    `SELECT to_char(o.start_time, 'HH24:MI') AS start_time, to_char(o.end_time, 'HH24:MI') AS end_time
       FROM routes r JOIN routes o ON o.daily_plan_id = r.daily_plan_id AND o.id <> r.id
      WHERE r.id = $1 AND o.driver_id = $2 AND o.start_time < r.end_time AND r.start_time < o.end_time
      ORDER BY o.start_time, o.id LIMIT 1`,
    [route.id, driverId],
  ) as QueryResult;
  const busy = overlap.rows[0];
  if (busy) throw new PlanningError(409, `This Chofer already has another Recorrido at that time: ${busy.start_time}-${busy.end_time}`);
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

// A Marca in force: not an undo and not replaced by a Corrección. The Traslado's state is its latest one in force.
// A Marca is in force unless it is an undo or a Corrección replaced it: an undo, or a corrected outcome nobody undid. Undoing
// a Corrección so puts back the Marca it replaced. REPLACES_SQL is that test on a Corrección (alias c).
const REPLACES_SQL = "(c.kind = 'undo' OR NOT EXISTS (SELECT 1 FROM marks u WHERE u.corrects_mark_id = c.id AND u.kind = 'undo'))";
const MARK_IN_FORCE_SQL = `e.kind <> 'undo' AND NOT EXISTS (SELECT 1 FROM marks c WHERE c.corrects_mark_id = e.id AND ${REPLACES_SQL})`;
// Marcas (alias e) newest first in `markOrder` of @traslado/shared: by phone time, then by arrival at the server.
const LATEST_MARK_FIRST_SQL = "ORDER BY e.phone_time DESC, e.id DESC";

// The local minute of the Traslado's (alias t) latest Subió in force: when the Pasajero actually got on. A Subió that was
// undone or corrected does not count.
const BOARDED_MINUTES_SQL = `(SELECT EXTRACT(EPOCH FROM (e.phone_time AT TIME ZONE '${LOCAL_TIME_ZONE}')::time) / 60
    FROM marks e WHERE e.transfer_id = t.id AND e.kind = 'subio' AND ${MARK_IN_FORCE_SQL} ${LATEST_MARK_FIRST_SQL} LIMIT 1)`;

/**
 * The local minute a leg after a Trasbordo (the transfers row aliased `t`) started riding: the first leg of its chain's
 * latest Subió, else that leg's pickup in the latest version of its Recorrido published since the split (t was created
 * then), else its planned pickup in the current order. Null for a Traslado that is not such a leg, and while the first
 * leg has no time yet.
 */
function rideStartMinutesSql(t = "t") {
  return `(CASE WHEN ${t}.chained_from_transfer_id IS NOT NULL THEN (
    WITH RECURSIVE chain(id, previous) AS (
      SELECT ${t}.id, ${t}.chained_from_transfer_id
      UNION ALL SELECT c.id, c.chained_from_transfer_id FROM transfers c JOIN chain ON c.id = chain.previous)
    SELECT COALESCE(
      (SELECT EXTRACT(EPOCH FROM (m.phone_time AT TIME ZONE '${LOCAL_TIME_ZONE}')::time) / 60
         FROM marks m WHERE m.transfer_id = chain.id AND m.kind = 'subio' ORDER BY m.phone_time DESC, m.id DESC LIMIT 1),
      (SELECT EXTRACT(EPOCH FROM l.planned_time) / 60 FROM plan_version_legs l JOIN plan_versions pv ON pv.id = l.plan_version_id
        WHERE l.transfer_id = chain.id AND l.kind = 'pickup' AND pv.published_at >= ${t}.created_at
          AND pv.route_id = (SELECT route_id FROM stops WHERE transfer_id = chain.id AND kind = 'pickup')
        ORDER BY pv.version DESC LIMIT 1),
      (SELECT EXTRACT(EPOCH FROM fs.planned_time) / 60 FROM stops fs WHERE fs.transfer_id = chain.id AND fs.kind = 'pickup'))
      FROM chain WHERE chain.previous IS NULL) END)`;
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
         to_char(t.exit_time, 'HH24:MI') AS exit_time, t.companions, p.name, t.status, ${BOARDED_MINUTES_SQL} AS boarded_minutes,
         p.home_latitude, p.home_longitude, p.front_seat, p.max_ride_time_minutes, p.pickup_duration_minutes,
         p.dropoff_duration_minutes, d.latitude AS d_lat, d.longitude AS d_lng, d.arrival_tolerance_minutes,
         o.latitude AS o_lat, o.longitude AS o_lng, t.trasbordo_stop, t.trasbordo_latitude, t.trasbordo_longitude,
         EXTRACT(EPOCH FROM t.trasbordo_time) / 60 AS trasbordo_minutes, ${rideStartMinutesSql()} AS ride_start_minutes,
         nx.trasbordo_latitude AS next_trasbordo_latitude, nx.trasbordo_longitude AS next_trasbordo_longitude,
         ARRAY(SELECT feature_id FROM passenger_required_features f WHERE f.passenger_id = p.id ORDER BY feature_id) AS feature_ids
    FROM stops s
    JOIN transfers t ON t.id = s.transfer_id
    JOIN passengers p ON p.id = t.passenger_id
    JOIN destinations d ON d.id = t.destination_id
    LEFT JOIN destinations o ON o.id = t.origin_destination_id
    ${NEXT_LEG_JOIN_SQL}
   WHERE s.route_id = $1 AND s.kind = 'pickup'
   ORDER BY s.position`;

// Where the last Parada of a Recorrido is, its Traslado and when its service ends (null while it has no planned time).
const LAST_STOP_SQL = `
  SELECT s.transfer_id,
         CASE WHEN s.kind = 'dropoff' AND nx.id IS NOT NULL THEN nx.trasbordo_latitude
              WHEN s.kind = t.trasbordo_stop THEN t.trasbordo_latitude
              WHEN (s.kind = 'pickup') = (t.direction = 'entrada') THEN COALESCE(o.latitude, p.home_latitude) ELSE d.latitude END AS lat,
         CASE WHEN s.kind = 'dropoff' AND nx.id IS NOT NULL THEN nx.trasbordo_longitude
              WHEN s.kind = t.trasbordo_stop THEN t.trasbordo_longitude
              WHEN (s.kind = 'pickup') = (t.direction = 'entrada') THEN COALESCE(o.longitude, p.home_longitude) ELSE d.longitude END AS lng,
         EXTRACT(EPOCH FROM s.planned_time) / 60
           + CASE s.kind WHEN 'pickup' THEN p.pickup_duration_minutes ELSE p.dropoff_duration_minutes END AS planned_end
    FROM stops s
    JOIN transfers t ON t.id = s.transfer_id
    JOIN passengers p ON p.id = t.passenger_id
    JOIN destinations d ON d.id = t.destination_id
    LEFT JOIN destinations o ON o.id = t.origin_destination_id
    ${NEXT_LEG_JOIN_SQL}
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
  if (kind === "dropoff" && row.next_trasbordo_latitude !== null && row.next_trasbordo_latitude !== undefined) {
    return lngLat(row.next_trasbordo_latitude, row.next_trasbordo_longitude);
  }
  if (row.trasbordo_stop === kind) return lngLat(row.trasbordo_latitude, row.trasbordo_longitude);
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
    ...(row.trasbordo_stop === null ? {} : {
      trasbordo: { stop: row.trasbordo_stop as "pickup" | "dropoff", minutes: Number(row.trasbordo_minutes) },
    }),
    ...(row.ride_start_minutes === null ? {} : { rideStartMinutes: Number(row.ride_start_minutes) }),
  };
}

/**
 * What the validator needs about a Trasbordo leg: its ride counts from the chain's start, and its end at the point is held
 * to [t, t + 5] while it has not happened yet (an on-board leg B's pickup is done).
 */
function trasbordoRules(leg: { trasbordoStop: string | null; trasbordoMinutes: number | null; rideStartMinutes: number | null; status: string }) {
  const pending = leg.trasbordoStop !== null && !(leg.trasbordoStop === "pickup" && leg.status !== "planificado");
  const rules: Partial<ValidatorTransfer> = {};
  if (leg.rideStartMinutes !== null) rules.rideStartMinutes = leg.rideStartMinutes;
  if (pending) {
    const stop = leg.trasbordoStop as "pickup" | "dropoff";
    rules.trasbordo = { stop, earliest: leg.trasbordoMinutes!, latest: leg.trasbordoMinutes! + TRASBORDO_WINDOW_MINUTES };
  }
  return rules;
}

// The applied order checked by the route validator; entradas accept arrival up to T + the Destino's Tolerancia de llegada.
// An on-board Pasajero (Subió) rides from their actual Subió, which comes before every planned Parada.
function validateOrder(
  rows: Record<string, unknown>[],
  stops: { transferId: number; kind: "pickup" | "dropoff"; plannedSeconds: number }[],
  route: Record<string, unknown>,
) {
  const placed = new Set(stops.map((stop) => stop.transferId));
  const served = rows.filter((row) => placed.has(Number(row.id)));
  const boarded = served.filter((row) => row.status === "subio");
  const validatorStops: ValidatorStop[] = [
    ...boarded.map((row) => ({ id: `${row.id}-pickup`, transferId: String(row.id), type: "pickup" as const, plannedTime: Number(row.boarded_minutes) })),
    ...stops.map((stop) => ({
      id: `${stop.transferId}-${stop.kind}`,
      transferId: String(stop.transferId),
      type: stop.kind,
      plannedTime: stop.plannedSeconds / 60,
    })),
  ];
  return forgetBoardedPickups(validateRoute({
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
      ...trasbordoRules({
        trasbordoStop: row.trasbordo_stop as string | null, trasbordoMinutes: nullableNumber(row.trasbordo_minutes),
        rideStartMinutes: nullableNumber(row.ride_start_minutes), status: String(row.status),
      }),
    })),
  }), boarded.map((row) => ({ id: Number(row.id), direction: String(row.direction) })));
}

type Point = { lat: number; lng: number };

// Where a Parada is: an entrada is picked up at its origin Destino or at home and dropped at its Destino;
// a salida is picked up at its Destino and dropped at home. Expects aliases t (transfers), p (passengers),
// d (destinations), o (origin destinations) and nx (NEXT_LEG_JOIN_SQL), and the Parada kind as `kindSql`.
function stopPointSql(kindSql: string) {
  const home = `${kindSql} = 'pickup' AND t.direction = 'entrada'`;
  return `
    CASE WHEN ${kindSql} = 'dropoff' AND nx.id IS NOT NULL THEN nx.trasbordo_latitude
         WHEN ${kindSql} = t.trasbordo_stop THEN t.trasbordo_latitude
         WHEN ${home} THEN COALESCE(o.latitude, p.home_latitude)
         WHEN ${kindSql} = 'dropoff' AND t.direction = 'salida' THEN p.home_latitude
         ELSE d.latitude END AS lat,
    CASE WHEN ${kindSql} = 'dropoff' AND nx.id IS NOT NULL THEN nx.trasbordo_longitude
         WHEN ${kindSql} = t.trasbordo_stop THEN t.trasbordo_longitude
         WHEN ${home} THEN COALESCE(o.longitude, p.home_longitude)
         WHEN ${kindSql} = 'dropoff' AND t.direction = 'salida' THEN p.home_longitude
         ELSE d.longitude END AS lng,
    CASE WHEN ${kindSql} = 'pickup' THEN p.pickup_duration_minutes ELSE p.dropoff_duration_minutes END AS "serviceMinutes"`;
}

const TRANSFER_PLACES_SQL = `
  JOIN transfers t ON t.id = s.transfer_id
  JOIN passengers p ON p.id = t.passenger_id
  JOIN destinations d ON d.id = t.destination_id
  LEFT JOIN destinations o ON o.id = t.origin_destination_id
  ${NEXT_LEG_JOIN_SQL}`;

type PublicationStop = {
  transferId: number;
  kind: "pickup" | "dropoff";
  point: Point;
  serviceMinutes: number;
  // The local minute of the Marca that did this end of a Trasbordo leg (A's Entregado, B's Subió), null otherwise.
  handoverMinutes: number | null;
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
  status: string;
  // Local minute of the Traslado's latest Subió, null without one.
  boardedMinutes: number | null;
  trasbordoStop: string | null;
  trasbordoMinutes: number | null;
  // A leg after a Trasbordo rides since its chain's start (rideStartMinutesSql); null otherwise.
  rideStartMinutes: number | null;
};
// A leg of the latest Versión del plan, with its planned time to the second.
type LatestLeg = { position: number; transferId: number; kind: string; distanceMeters: number; durationSeconds: number; plannedMinutes: number };
type PublicationSnapshot = {
  route: { id: number; dailyPlanId: number; driverId: number; vehicleId: number; startTime: string; endTime: string; status: string };
  vehicle: { seats: number; features: string[] };
  stops: PublicationStop[];
  transfers: PublicationTransfer[];
  latestLegs: LatestLeg[];
};

const DONE_STOPS_FIRST = "A done Parada never changes: done Paradas stay first, in the order of the latest version";

// A done Parada already happened: a pickup marked Subió, Entregado or Ausente, or a drop-off marked Entregado.
function isDoneStop(kind: string, status: string) {
  return kind === "pickup" ? ["subio", "entregado", "ausente"].includes(status) : status === "entregado";
}

const LATEST_LEGS_SQL = `
  SELECT l.position, l.transfer_id, l.kind, l.distance_meters, l.duration_seconds, EXTRACT(EPOCH FROM l.planned_time) / 60 AS minutes
    FROM plan_version_legs l JOIN plan_versions pv ON pv.id = l.plan_version_id
   WHERE pv.route_id = $1 AND pv.version = (SELECT max(version) FROM plan_versions WHERE route_id = $1)
   ORDER BY l.position`;

async function loadLatestLegs(client: Queryable, routeId: number): Promise<LatestLeg[]> {
  return ((await client.query(LATEST_LEGS_SQL, [routeId]) as QueryResult).rows).map((leg) => ({
    position: Number(leg.position),
    transferId: Number(leg.transfer_id),
    kind: String(leg.kind),
    distanceMeters: Number(leg.distance_meters),
    durationSeconds: Number(leg.duration_seconds),
    plannedMinutes: Number(leg.minutes),
  }));
}

/**
 * The latest version's legs of the done Paradas, which must be the first ones, in that version's order: what already
 * happened is never planned again, so the next version keeps their legs and planned times. A done end of a Trasbordo leg,
 * which no version may have planned there, keeps the time of its Marca with the leg routed now (`routed`).
 */
function lockedLegs(snapshot: PublicationSnapshot, routed: RouteLeg[]) {
  const status = new Map(snapshot.transfers.map((transfer) => [transfer.id, transfer.status]));
  const count = snapshot.stops.filter((stop) => isDoneStop(stop.kind, status.get(stop.transferId)!)).length;
  const legs = snapshot.stops.slice(0, count).map((stop, index) => {
    if (!isDoneStop(stop.kind, status.get(stop.transferId)!)) return undefined;
    if (stop.handoverMinutes !== null) return { position: null, ...routed[index], plannedMinutes: stop.handoverMinutes };
    return snapshot.latestLegs.find((leg) => leg.transferId === stop.transferId && leg.kind === stop.kind);
  });
  const versioned = legs.filter((leg) => leg?.position !== null);
  if (legs.includes(undefined) || versioned.some((leg, index) => index > 0 && leg!.position! <= versioned[index - 1]!.position!)) {
    throw new PlanningError(409, DONE_STOPS_FIRST);
  }
  return legs as { position: number | null; distanceMeters: number; durationSeconds: number; plannedMinutes: number }[];
}

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
    `SELECT s.transfer_id AS "transferId", s.kind, ${stopPointSql("s.kind")},
            CASE WHEN s.kind = t.trasbordo_stop OR (s.kind = 'dropoff' AND nx.id IS NOT NULL) THEN (
              SELECT EXTRACT(EPOCH FROM (m.phone_time AT TIME ZONE '${LOCAL_TIME_ZONE}')::time) / 60 FROM marks m
               WHERE m.transfer_id = t.id AND m.kind = CASE s.kind WHEN 'pickup' THEN 'subio' ELSE 'entregado' END
               ORDER BY m.phone_time DESC, m.id DESC LIMIT 1) END AS "handoverMinutes"
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
            t.status, ${BOARDED_MINUTES_SQL} AS "boardedMinutes", t.trasbordo_stop AS "trasbordoStop",
            EXTRACT(EPOCH FROM t.trasbordo_time) / 60 AS "trasbordoMinutes", ${rideStartMinutesSql()} AS "rideStartMinutes",
            CASE WHEN t.trasbordo_stop = 'pickup' THEN t.trasbordo_latitude
                 ELSE COALESCE(o.latitude, CASE WHEN t.direction = 'entrada' THEN p.home_latitude ELSE d.latitude END) END AS "fromLat",
            CASE WHEN t.trasbordo_stop = 'pickup' THEN t.trasbordo_longitude
                 ELSE COALESCE(o.longitude, CASE WHEN t.direction = 'entrada' THEN p.home_longitude ELSE d.longitude END) END AS "fromLng",
            CASE WHEN nx.id IS NOT NULL THEN nx.trasbordo_latitude WHEN t.trasbordo_stop = 'dropoff' THEN t.trasbordo_latitude
                 WHEN t.direction = 'entrada' THEN d.latitude ELSE p.home_latitude END AS "toLat",
            CASE WHEN nx.id IS NOT NULL THEN nx.trasbordo_longitude WHEN t.trasbordo_stop = 'dropoff' THEN t.trasbordo_longitude
                 WHEN t.direction = 'entrada' THEN d.longitude ELSE p.home_longitude END AS "toLng"
       FROM transfers t
       JOIN passengers p ON p.id = t.passenger_id
       JOIN destinations d ON d.id = t.destination_id
       LEFT JOIN destinations o ON o.id = t.origin_destination_id
       ${NEXT_LEG_JOIN_SQL}
       LEFT JOIN passenger_required_features rf ON rf.passenger_id = p.id
      WHERE t.id IN (SELECT transfer_id FROM stops WHERE route_id = $1)
      GROUP BY t.id, p.id, d.id, o.id, nx.id ORDER BY t.id`,
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
      handoverMinutes: nullableNumber(stop.handoverMinutes),
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
      status: String(transfer.status),
      boardedMinutes: nullableNumber(transfer.boardedMinutes),
      trasbordoStop: (transfer.trasbordoStop as string | null) ?? null,
      trasbordoMinutes: nullableNumber(transfer.trasbordoMinutes),
      rideStartMinutes: nullableNumber(transfer.rideStartMinutes),
    })),
    latestLegs: await loadLatestLegs(client, routeId),
  };
}

/**
 * What a Versión del plan was computed from: every input of the snapshot, so any change that can move distances, times
 * or the validator's verdict changes it. Left out: the status, which publishing itself changes, the Pasajero's name, and
 * the Marcas and the latest version, which are what happened and what was published, not a change to the plan; so is a
 * Trasbordo leg's ride start, which leg A's Marcas and versions move. A Traslado without a Trasbordo signs as it did before
 * Trasbordos existed, so no version looks changed.
 */
function publicationSignature(snapshot: PublicationSnapshot) {
  const { status: _status, ...route } = snapshot.route;
  const transfers = snapshot.transfers.map(({
    passengerName: _name, status: _marked, boardedMinutes: _boarded, rideStartMinutes: _rideStart, trasbordoStop, trasbordoMinutes, ...transfer
  }) => trasbordoStop === null ? transfer : { ...transfer, trasbordoStop, trasbordoMinutes });
  const stops = snapshot.stops.map(({ handoverMinutes: _handover, ...stop }) => stop);
  return createHash("sha256").update(JSON.stringify({ route, vehicle: snapshot.vehicle, stops, transfers })).digest("hex");
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
 * pickup, or a Trasbordo leg's end at the point) on or before its target time; each next Parada follows after the service at the previous one and the leg.
 * The first `locked` Paradas (the done ones) keep their minutes, and the rest cannot start before the last of them ends.
 */
function plannedMinutes(snapshot: PublicationSnapshot, legs: RouteLeg[], locked: number[] = []) {
  const first = locked.length;
  const stops = snapshot.stops.slice(first);
  const relative: number[] = [];
  stops.forEach((stop, index) => {
    relative.push(index === 0 ? 0 : relative[index - 1] + stops[index - 1].serviceMinutes + legs[first + index].durationSeconds / 60);
  });
  const slack = stops.flatMap((stop, index) => {
    const transfer = snapshot.transfers.find((candidate) => candidate.id === stop.transferId)!;
    // A Trasbordo leg's end at the point is due by t + 5, whether or not it is the one with the target time.
    if (transfer.trasbordoStop === stop.kind) return [transfer.trasbordoMinutes! + TRASBORDO_WINDOW_MINUTES - relative[index]];
    const isTarget = (transfer.direction === "entrada") === (stop.kind === "dropoff");
    return isTarget ? [minutesOf(transfer.targetTime) - relative[index]] : [];
  });
  const earliest = first && stops.length
    ? locked[first - 1] + snapshot.stops[first - 1].serviceMinutes + legs[first].durationSeconds / 60
    : undefined;
  let start = slack.length ? Math.min(...slack) : earliest ?? minutesOf(snapshot.route.startTime);
  if (earliest !== undefined) start = Math.max(start, earliest);
  return [...locked, ...relative.map((minutes) => start + minutes)];
}

/**
 * The validator on what can still happen: closed Traslados (Entregado, Ausente) are left out, an on-board Pasajero's ride
 * counts from their actual Subió, and an on-board salida's pickup is not held to its target time any more.
 */
function validatePublication(snapshot: PublicationSnapshot, planned: number[]) {
  const open = snapshot.transfers.filter((transfer) => !CLOSED_TRANSFER_STATUSES.includes(transfer.status));
  const boarded = new Map(open.filter((transfer) => transfer.status === "subio" && transfer.boardedMinutes !== null)
    .map((transfer) => [transfer.id, transfer.boardedMinutes!]));
  return forgetBoardedPickups(validateRoute({
    route: snapshot.stops.flatMap((stop, index) => open.some((transfer) => transfer.id === stop.transferId) ? [{
      id: String(index + 1),
      transferId: String(stop.transferId),
      type: stop.kind,
      plannedTime: stop.kind === "pickup" && boarded.has(stop.transferId) ? boarded.get(stop.transferId)! : planned[index],
    }] : []),
    passengers: [...new Map(open.map((transfer) => [transfer.passengerId, {
      id: String(transfer.passengerId),
      maxRideTimeMinutes: transfer.maxRideTimeMinutes,
      frontSeat: transfer.frontSeat,
      requiredFeatures: transfer.requiredFeatures,
      pickupDurationMinutes: transfer.pickupDurationMinutes,
      dropoffDurationMinutes: transfer.dropoffDurationMinutes,
    }])).values()],
    vehicle: { id: String(snapshot.route.vehicleId), capacity: { seats: snapshot.vehicle.seats, front: 1 }, features: snapshot.vehicle.features },
    transfers: open.map((transfer) => ({
      id: String(transfer.id),
      passengerId: String(transfer.passengerId),
      direction: transfer.direction,
      targetTime: minutesOf(transfer.targetTime),
      companions: transfer.companions,
      ...trasbordoRules(transfer),
    })),
  }), open.filter((transfer) => boarded.has(transfer.id)));
}

// The pickup of an on-board salida already happened: its target time is no longer something to fix.
function forgetBoardedPickups(violations: RouteViolation[], boarded: { id: number; direction: string }[]) {
  const salidas = new Set(boarded.filter((transfer) => transfer.direction === "salida").map((transfer) => String(transfer.id)));
  return violations.filter((violation) => violation.rule !== "target_time_window_broken" || !salidas.has(violation.transferId ?? ""));
}

// Everything the engine was given, the neighbouring Recorridos included; the result is applied only while this is unchanged.
async function orderInputKey(client: Queryable, routeId: number) {
  const route = (await client.query(ORDER_ROUTE_SQL, [routeId]) as QueryResult).rows[0];
  const rows = route ? (await client.query(ORDER_TRANSFERS_SQL, [routeId]) as QueryResult).rows : [];
  const neighbours = route ? await loadNeighbours(client, routeId, route) : {};
  const stops = (await client.query("SELECT transfer_id, kind FROM stops WHERE route_id = $1 ORDER BY position", [routeId]) as QueryResult).rows
    .map((stop) => ({ transferId: Number(stop.transfer_id), kind: stop.kind as "pickup" | "dropoff" }));
  const latestLegs = await loadLatestLegs(client, routeId);
  return { route, rows, neighbours, stops, latestLegs, key: JSON.stringify([route, rows, neighbours, stops, latestLegs]) };
}

/**
 * Locks every row Order read until it commits, so nothing changes between its last check and the commit: its Traslados
 * and the previous Recorrido's last one, the Recorrido and its neighbours, the Chofer, the Vehículo, and the Pasajeros
 * and Destinos of those Traslados. Every writer of these rows locks them first, so it waits. The order follows the other
 * writers: Traslados before Recorridos as in PATCH /transfers, the Chofer before the Vehículo as in publishing. Deactivating
 * a Vehículo goes the other way; if it meets Order, Postgres aborts one of the two and nothing is saved half-way.
 */
async function lockOrderInputs(client: Queryable, routeId: number, rows: Record<string, unknown>[], neighbours: Neighbours) {
  const transferIds = [...rows.map((row) => Number(row.id)), ...(neighbours.last ? [Number(neighbours.last.transfer_id)] : [])];
  await client.query("SELECT id FROM transfers WHERE id = ANY($1::int[]) ORDER BY id FOR SHARE", [transferIds]);
  const routeIds = [routeId, neighbours.previous?.id, neighbours.next?.id].filter((value) => value !== undefined).map(Number);
  await client.query("SELECT id FROM routes WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE", [routeIds]);
  await lockRoute(client, routeId);
  await client.query("SELECT d.id FROM drivers d JOIN routes r ON r.driver_id = d.id WHERE r.id = $1 FOR SHARE OF d", [routeId]);
  await client.query("SELECT v.id FROM vehicles v JOIN routes r ON r.vehicle_id = v.id WHERE r.id = $1 FOR SHARE OF v", [routeId]);
  await client.query(
    "SELECT id FROM passengers WHERE id IN (SELECT passenger_id FROM transfers WHERE id = ANY($1::int[])) ORDER BY id FOR SHARE",
    [transferIds],
  );
  await client.query(
    `SELECT id FROM destinations
      WHERE id IN (SELECT destination_id FROM transfers WHERE id = ANY($1::int[])
                   UNION SELECT origin_destination_id FROM transfers WHERE id = ANY($1::int[]))
      ORDER BY id FOR SHARE`,
    [transferIds],
  );
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

const PLAN_TIME_ZONE = "America/Argentina/Tucuman";
const OUT_OF_DRIVER_SCOPE = "Only today's and tomorrow's Recorridos are available";
const NOT_OWN_ROUTE = "This Recorrido belongs to another Chofer";
// The Chofer of a Recorrido `r`: the one of its latest Versión del plan, as the Chofer app shows it.
const ROUTE_OWNER_SQL = "COALESCE((SELECT pv.driver_id FROM plan_versions pv WHERE pv.route_id = r.id ORDER BY pv.version DESC LIMIT 1), r.driver_id)";

/** Today and tomorrow in the Plan diario's zone: the only days a Chofer can read or acknowledge. */
function driverDays(now: Date) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: PLAN_TIME_ZONE }).format(now);
  const tomorrow = new Date(`${today}T00:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return [today, tomorrow.toISOString().slice(0, 10)];
}

/**
 * The Chofer's Recorridos of one day, each as its latest Versión del plan: a Recorrido never published is not shown
 * (tomorrow appears once it is published). A Recorrido is the Chofer's when its latest version is, so a change of Chofer
 * reaches the app with the next version. Every Parada carries where it is and what the Chofer needs about the Pasajero.
 */
async function loadDriverDay(client: Queryable, driverId: number, date: string) {
  const versions = await client.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (pv.route_id) pv.id, pv.route_id, pv.version, pv.driver_id, to_char(pv.start_time, 'HH24:MI') AS start_time,
              to_char(pv.end_time, 'HH24:MI') AS end_time, v.plate, r.status,
              (SELECT max(seen.version) FROM version_acknowledgements va JOIN plan_versions seen ON seen.id = va.plan_version_id
                WHERE seen.route_id = pv.route_id AND va.driver_id = $2) AS acknowledged
         FROM plan_versions pv JOIN routes r ON r.id = pv.route_id JOIN daily_plans dp ON dp.id = r.daily_plan_id
         JOIN vehicles v ON v.id = pv.vehicle_id
        WHERE dp.plan_date = $1
        ORDER BY pv.route_id, pv.version DESC) latest
     WHERE driver_id = $2
     ORDER BY start_time, route_id`,
    [date, driverId],
  ) as QueryResult;
  const legs = await client.query(
    `SELECT l.plan_version_id, l.position, l.kind, to_char(l.planned_time, 'HH24:MI') AS planned_time, l.transfer_id, t.direction,
            t.status, t.destination_id, t.origin_destination_id, pvt.companions, p.name, p.home_address, p.access_notes AS home_notes, p.wheelchair, p.medical_alert,
            CASE WHEN l.kind = 'dropoff' AND nx.id IS NOT NULL THEN 'dropoff' ELSE t.trasbordo_stop END AS trasbordo_stop,
            CASE WHEN l.kind = 'dropoff' AND nx.id IS NOT NULL THEN nx.trasbordo_latitude ELSE t.trasbordo_latitude END AS trasbordo_latitude,
            CASE WHEN l.kind = 'dropoff' AND nx.id IS NOT NULL THEN nx.trasbordo_longitude ELSE t.trasbordo_longitude END AS trasbordo_longitude,
            d.name AS d_name, d.address AS d_address, d.access_notes AS d_notes,
            o.name AS o_name, o.address AS o_address, o.access_notes AS o_notes
       FROM plan_version_legs l
       JOIN plan_version_transfers pvt ON pvt.plan_version_id = l.plan_version_id AND pvt.transfer_id = l.transfer_id
       JOIN transfers t ON t.id = l.transfer_id
       JOIN passengers p ON p.id = t.passenger_id
       JOIN destinations d ON d.id = t.destination_id
       LEFT JOIN destinations o ON o.id = t.origin_destination_id
       ${NEXT_LEG_JOIN_SQL}
      WHERE l.plan_version_id = ANY($1::int[]) ORDER BY l.plan_version_id, l.position`,
    [versions.rows.map((row) => Number(row.id))],
  ) as QueryResult;
  const stop = (leg: Record<string, unknown>) => {
    // An entrada is picked up at its origin Destino or at home and dropped at its Destino; a salida the other way round.
    const prefix = leg.kind === "pickup"
      ? (leg.direction === "entrada" ? (leg.o_name === null ? null : "o") : "d")
      : (leg.direction === "entrada" ? "d" : null);
    return {
      position: Number(leg.position),
      kind: String(leg.kind),
      plannedTime: String(leg.planned_time),
      transferId: Number(leg.transfer_id),
      direction: String(leg.direction),
      // The Traslado's state now (Planificado, Subió, Entregado, ...), so the app shows what is already marked.
      transferStatus: String(leg.status),
      // Only at a Trasbordo end: the Oficina records the handover there, so the app offers no Marca.
      ...(leg.trasbordo_stop === leg.kind ? { trasbordo: true } : {}),
      // destinationId is the Destino the Chofer marks as Receptor at a drop-off there; null at home and at a Trasbordo point.
      place: leg.trasbordo_stop === leg.kind
        ? { name: "Trasbordo", destinationId: null, address: `${leg.trasbordo_latitude}, ${leg.trasbordo_longitude}`, accessNotes: null }
        : prefix === null
        ? { name: null, destinationId: null, address: String(leg.home_address), accessNotes: (leg.home_notes as string | null) ?? null }
        : {
          name: String(leg[`${prefix}_name`]),
          destinationId: Number(prefix === "o" ? leg.origin_destination_id : leg.destination_id),
          address: String(leg[`${prefix}_address`]),
          accessNotes: (leg[`${prefix}_notes`] as string | null) ?? null,
        },
      passenger: { name: String(leg.name), wheelchair: Boolean(leg.wheelchair), medicalAlert: (leg.medical_alert as string | null) ?? null },
      companions: Number(leg.companions),
    };
  };
  // What changed is measured from the version the Chofer acknowledged, or from the previous one once they saw this one.
  const since = (row: Record<string, unknown>) => {
    const acknowledged = nullableNumber(row.acknowledged);
    return acknowledged !== null && acknowledged < Number(row.version) ? acknowledged : Number(row.version) - 1;
  };
  const earlier = versions.rows.filter((row) => since(row) >= 1);
  const bases = (await client.query(
    `SELECT pv.id, pv.route_id, pv.version, v.plate FROM plan_versions pv JOIN vehicles v ON v.id = pv.vehicle_id
      WHERE (pv.route_id, pv.version) IN (SELECT * FROM unnest($1::int[], $2::int[]))`,
    [earlier.map((row) => Number(row.route_id)), earlier.map(since)],
  ) as QueryResult).rows;
  const baseLegs = (await client.query(
    `SELECT l.plan_version_id, l.transfer_id, l.kind, to_char(l.planned_time, 'HH24:MI') AS planned_time, p.name
       FROM plan_version_legs l JOIN transfers t ON t.id = l.transfer_id JOIN passengers p ON p.id = t.passenger_id
      WHERE l.plan_version_id = ANY($1::int[]) ORDER BY l.plan_version_id, l.position`,
    [bases.map((base) => Number(base.id))],
  ) as QueryResult).rows;
  const changes = (row: Record<string, unknown>, stops: ReturnType<typeof stop>[]) => {
    const base = bases.find((item) => Number(item.route_id) === Number(row.route_id));
    if (!base) return null;
    const before = baseLegs.filter((leg) => Number(leg.plan_version_id) === Number(base.id));
    const items: VersionChange[] = [];
    if (base.plate !== row.plate) items.push({ kind: "vehicle", from: String(base.plate), to: String(row.plate) });
    for (const current of stops.filter((item) => item.kind === "pickup")) {
      if (!before.some((leg) => Number(leg.transfer_id) === current.transferId)) {
        items.push({ kind: "added", transferId: current.transferId, passengerName: current.passenger.name });
      }
    }
    for (const leg of before.filter((item) => item.kind === "pickup")) {
      if (!stops.some((item) => item.transferId === Number(leg.transfer_id))) {
        items.push({ kind: "removed", transferId: Number(leg.transfer_id), passengerName: String(leg.name) });
      }
    }
    for (const current of stops) {
      const old = before.find((leg) => Number(leg.transfer_id) === current.transferId && leg.kind === current.kind);
      if (old && old.planned_time !== current.plannedTime) {
        items.push({
          kind: "time", transferId: current.transferId, stopKind: current.kind, passengerName: current.passenger.name,
          from: String(old.planned_time), to: current.plannedTime,
        });
      }
    }
    return { sinceVersion: Number(base.version), items };
  };
  return {
    date,
    routes: versions.rows.map((row) => {
      const stops = legs.rows.filter((leg) => Number(leg.plan_version_id) === Number(row.id)).map(stop);
      const changed = changes(row, stops);
      return {
        routeId: Number(row.route_id),
        version: Number(row.version),
        startTime: String(row.start_time),
        endTime: String(row.end_time),
        vehiclePlate: String(row.plate),
        status: String(row.status),
        acknowledgedVersion: nullableNumber(row.acknowledged),
        stops,
        // Only from version 2 on: what changed since the version it is measured from.
        ...(changed ? { changes: changed } : {}),
      };
    }),
  };
}

type VersionChange =
  | { kind: "vehicle"; from: string; to: string }
  | { kind: "added" | "removed"; transferId: number; passengerName: string }
  | { kind: "time"; transferId: number; stopKind: string; passengerName: string; from: string; to: string };

// "undo" is only a Corrección: it takes back the Marca it corrects.
type MarkKind = "subio" | "ausente" | "entregado" | "undo";
type MarkReceiver =
  | { kind: "authorized_adult"; adultId: number }
  | { kind: "destination"; destinationId: number }
  | { kind: "other_adult"; name: string; dni: string; authorizationId: number | null }
  | { kind: "base_staff" }
  // The receiving Chofer of a Trasbordo; only the Oficina's Trasbordo records it.
  | { kind: "driver"; driverId: number };
type MarkLocation = { lat: number; lng: number } | null;
type MarkFields = {
  id: string;
  transferId: number;
  kind: MarkKind;
  phoneTime: string;
  location: MarkLocation;
  version: number;
  receiver: MarkReceiver | null;
  // The UUID of the Marca a Corrección replaces.
  corrects?: string;
};

const MARK_KINDS: MarkKind[] = ["subio", "ausente", "entregado", "undo"];
// The Chofer corrects their own Marca within this window between the phone times of both Marcas, so it works offline.
// A product default, not client-confirmed.
const CHOFER_CORRECTION_WINDOW_MS = 2 * 60 * 1000;
const CALL_THE_OFFICE_TO_CORRECT = "More than 2 minutes have passed since this Marca: call the Oficina to correct it";
const REASON_REQUIRED = "A Corrección by the Oficina requires a reason";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECEIVER_REQUIRED = "Entregado requires a Receptor";
// A Traslado in one of these states is closed: an Autorización puntual on it has expired.
const CLOSED_TRANSFER_STATUSES = ["entregado", "ausente", "cancelado_ausencia"];

/** The DNI as digits and sign only, so "12.345.678" and "12345678" are the same person. */
function normalizeDni(value: string) {
  return value.replace(/[.\s]/g, "");
}

function parseMarkReceiver(value: unknown): MarkReceiver | null {
  if (!isObject(value)) return null;
  if (value.kind === "authorized_adult") {
    const adultId = positiveInt(value.adultId);
    return adultId ? { kind: "authorized_adult", adultId } : null;
  }
  if (value.kind === "destination") {
    const destinationId = positiveInt(value.destinationId);
    return destinationId ? { kind: "destination", destinationId } : null;
  }
  if (value.kind === "other_adult") {
    const name = boundedText(value.name, 200);
    const dni = boundedText(value.dni, 20);
    const authorizationId = value.authorizationId === undefined || value.authorizationId === null ? null : positiveInt(value.authorizationId);
    if (!name || !dni || (value.authorizationId !== undefined && value.authorizationId !== null && !authorizationId)) return null;
    return { kind: "other_adult", name, dni, authorizationId };
  }
  return value.kind === "base_staff" ? { kind: "base_staff" } : null;
}

/** A Marca as the phone sends it; only Entregado carries a Receptor, and it must. */
function parseMark(body: unknown): MarkFields | { error: string } | null {
  if (!isObject(body)) return null;
  const id = typeof body.id === "string" && UUID_PATTERN.test(body.id) ? body.id.toLowerCase() : null;
  const transferId = positiveInt(body.transferId);
  const version = positiveInt(body.version);
  const kind = MARK_KINDS.find((candidate) => candidate === body.kind);
  const phoneTime = typeof body.phoneTime === "string" && /T.*(Z|[+-]\d{2}:\d{2})$/.test(body.phoneTime) ? new Date(body.phoneTime) : null;
  const corrects = body.corrects === undefined || body.corrects === null ? null
    : typeof body.corrects === "string" && UUID_PATTERN.test(body.corrects) ? body.corrects.toLowerCase() : undefined;
  const location = body.location === null ? null : isObject(body.location)
    && typeof body.location.lat === "number" && Math.abs(body.location.lat) <= 90
    && typeof body.location.lng === "number" && Math.abs(body.location.lng) <= 180
    ? { lat: body.location.lat, lng: body.location.lng }
    : undefined;
  if (!id || !transferId || !version || !kind || !phoneTime || Number.isNaN(phoneTime.getTime()) || location === undefined) return null;
  if (corrects === undefined || (kind === "undo" && !corrects)) return null;
  if (kind === "entregado" && (body.receiver === undefined || body.receiver === null)) return { error: RECEIVER_REQUIRED };
  if (kind !== "entregado" && body.receiver !== undefined && body.receiver !== null) return null;
  const receiver = kind === "entregado" ? parseMarkReceiver(body.receiver) : null;
  if (kind === "entregado" && !receiver) return null;
  return { id, transferId, kind, phoneTime: phoneTime.toISOString(), location, version, receiver, ...(corrects ? { corrects } : {}) };
}

const POSITION_BATCH_LIMIT = 100;
const POSITION_FUTURE_TOLERANCE_MS = 2 * 60 * 1000;

type PositionInput = { lat: number; lng: number; accuracyMeters: number; phoneTime: string };

/** A batch of Chofer phone Posiciones; every entry is validated before anything is stored. */
function parsePositionBatch(body: unknown, serverNow: Date): PositionInput[] | null {
  if (!isObject(body) || !Array.isArray(body.positions)) return null;
  if (body.positions.length === 0 || body.positions.length > POSITION_BATCH_LIMIT) return null;
  const latestAllowed = serverNow.getTime() + POSITION_FUTURE_TOLERANCE_MS;
  const items: PositionInput[] = [];
  for (const entry of body.positions) {
    if (!isObject(entry)) return null;
    const lat = coordinate(entry.lat, 90);
    const lng = coordinate(entry.lng, 180);
    const accuracyMeters = typeof entry.accuracyMeters === "number" && Number.isFinite(entry.accuracyMeters) && entry.accuracyMeters >= 0
      ? entry.accuracyMeters
      : null;
    const phoneTime = typeof entry.phoneTime === "string" && /T.*(Z|[+-]\d{2}:\d{2})$/.test(entry.phoneTime)
      ? new Date(entry.phoneTime)
      : null;
    if (lat === null || lng === null || accuracyMeters === null || !phoneTime || Number.isNaN(phoneTime.getTime())) return null;
    if (phoneTime.getTime() > latestAllowed) return null;
    items.push({ lat, lng, accuracyMeters, phoneTime: phoneTime.toISOString() });
  }
  return items;
}

const MARK_SELECT_SQL = `
  SELECT m.id, m.client_id, m.driver_id, m.transfer_id, pv.route_id, pv.version, m.kind, m.phone_time, m.server_time, m.latitude, m.longitude,
         m.receiver_kind, m.receiver_adult_id, m.receiver_destination_id, m.receiver_name, m.receiver_dni, m.authorization_id, m.flags,
         c.client_id AS corrects_client_id, m.reason, u.id AS author_user_id, u.username AS author_username, u.role AS author_role,
         m.receiver_driver_id, tm.client_id AS trasbordo_client_id
    FROM marks m JOIN plan_versions pv ON pv.id = m.plan_version_id LEFT JOIN marks c ON c.id = m.corrects_mark_id
    LEFT JOIN marks tm ON tm.id = m.trasbordo_mark_id
    JOIN sessions s ON s.id = m.session_id JOIN users u ON u.id = s.user_id
`;

function formatMarkReceiver(row: Record<string, unknown>): MarkReceiver | null {
  switch (row.receiver_kind) {
    case "authorized_adult": return { kind: "authorized_adult", adultId: Number(row.receiver_adult_id) };
    case "destination": return { kind: "destination", destinationId: Number(row.receiver_destination_id) };
    case "other_adult": return {
      kind: "other_adult", name: String(row.receiver_name), dni: String(row.receiver_dni), authorizationId: nullableNumber(row.authorization_id),
    };
    case "base_staff": return { kind: "base_staff" };
    case "driver": return { kind: "driver", driverId: Number(row.receiver_driver_id) };
    default: return null;
  }
}

/** Only the last 3 digits of a DNI, without its dots and spaces; a DNI with fewer than 4 digits gives none of them. */
function maskDni(dni: string) {
  const digits = normalizeDni(dni);
  return digits.length < 4 ? "***" : `***${digits.slice(-3)}`;
}

/**
 * The Receptor as the history shows it: an Adulto autorizado or a Destino also by name, the adult with their relation,
 * another adult with a masked DNI. The Marca keeps the whole DNI, and the alerts still show it.
 */
function historyReceiver(receiver: MarkReceiver | null, row: Record<string, unknown>) {
  switch (receiver?.kind) {
    case "authorized_adult": return { ...receiver, name: String(row.receiver_adult_name), relation: String(row.receiver_relation) };
    case "destination": return { ...receiver, name: String(row.receiver_destination_name) };
    case "other_adult": return { ...receiver, dni: maskDni(receiver.dni) };
    default: return receiver;
  }
}

function formatMark(row: Record<string, unknown>) {
  return {
    id: String(row.client_id),
    transferId: Number(row.transfer_id),
    routeId: Number(row.route_id),
    version: Number(row.version),
    kind: String(row.kind) as MarkKind,
    phoneTime: new Date(String(row.phone_time)).toISOString(),
    serverTime: new Date(String(row.server_time)).toISOString(),
    location: row.latitude === null ? null : { lat: Number(row.latitude), lng: Number(row.longitude) },
    receiver: formatMarkReceiver(row),
    flags: row.flags as string[],
    // Only a Corrección names the Marca it replaces, and only the Oficina's has a reason.
    ...(row.corrects_client_id ? { corrects: String(row.corrects_client_id) } : {}),
    ...(row.reason ? { reason: String(row.reason) } : {}),
    // The Subió of a Trasbordo names the Entregado to its Chofer that it continues.
    ...(row.trasbordo_client_id ? { trasbordoOf: String(row.trasbordo_client_id) } : {}),
  };
}

/** What a Marca says, in one key order: two sends of one UUID are the same Marca only when this is equal. */
function markContent(mark: Omit<MarkFields, "id"> & { routeId: number }) {
  return JSON.stringify([
    mark.transferId, mark.routeId, mark.version, mark.kind, mark.phoneTime, mark.location, mark.receiver, ...(mark.corrects ? [mark.corrects] : []),
  ]);
}

async function insertAlert(client: Queryable, alert: {
  kind: string; transferId?: number | null; routeId?: number | null; markId?: number | null; details: unknown; dedupeKey?: string | null;
}, createdAt: Date) {
  await client.query(
    `INSERT INTO alerts (kind, transfer_id, route_id, mark_id, details, dedupe_key, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [alert.kind, alert.transferId ?? null, alert.routeId ?? null, alert.markId ?? null, JSON.stringify(alert.details), alert.dedupeKey ?? null, createdAt],
  );
}

// A Marca (alias e) uses an Autorización puntual only when it names it on that Traslado with the authorised DNI and is in
// force: a Marca naming it with another DNI, or on another Traslado, is flagged and leaves it unused, and an Entregado
// undone or replaced by a Corrección no longer uses it. Undoing that Corrección uses it again.
const AUTHORIZATION_USE_SQL = `e.authorization_id = oa.id AND e.transfer_id = oa.transfer_id
  AND regexp_replace(e.receiver_dni, '[.[:space:]]', '', 'g') = regexp_replace(oa.dni, '[.[:space:]]', '', 'g')
  AND ${MARK_IN_FORCE_SQL}`;

/**
 * An Autorización puntual with its state: used while a Marca in force uses it (even after a revocation), revoked, expired
 * once its Traslado closed unused, otherwise valid.
 */
const AUTHORIZATION_SELECT_SQL = `
  SELECT oa.id, oa.transfer_id, oa.authorized_by_adult_id, a.name AS authorized_by_name, oa.called_phone, oa.name, oa.dni,
         oa.recorded_by, oa.recorded_at, r.revoked_by, r.revoked_at,
         CASE WHEN EXISTS (SELECT 1 FROM marks e WHERE ${AUTHORIZATION_USE_SQL}) THEN 'used'
              WHEN r.authorization_id IS NOT NULL THEN 'revoked'
              WHEN t.status = ANY('{entregado,ausente,cancelado_ausencia}'::text[]) THEN 'expired'
              ELSE 'valid' END AS status
    FROM one_off_authorizations oa
    JOIN authorized_adults a ON a.id = oa.authorized_by_adult_id
    JOIN transfers t ON t.id = oa.transfer_id
    LEFT JOIN one_off_authorization_revocations r ON r.authorization_id = oa.id
`;

function formatAuthorization(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    transferId: Number(row.transfer_id),
    authorizedBy: { adultId: Number(row.authorized_by_adult_id), name: String(row.authorized_by_name) },
    calledPhone: String(row.called_phone),
    name: String(row.name),
    dni: String(row.dni),
    recordedBy: Number(row.recorded_by),
    recordedAt: new Date(String(row.recorded_at)).toISOString(),
    revokedBy: nullableNumber(row.revoked_by),
    revokedAt: row.revoked_at === null ? null : new Date(String(row.revoked_at)).toISOString(),
    status: String(row.status),
  };
}

// Fields that would say where the handover happens: an Autorización puntual never carries them.
const PLACE_FIELDS = ["address", "place", "lat", "lng", "location", "destinationId"];
const NOT_A_PLACE = "An Autorización puntual changes who receives, never where: a different place is a new Parada through a Versión del plan";

function parseAuthorization(body: unknown): { legalGuardianId: number; call: "outgoing" | "incoming"; name: string; dni: string } | { error: string } | null {
  if (!isObject(body)) return null;
  if (PLACE_FIELDS.some((field) => field in body)) return { error: NOT_A_PLACE };
  const legalGuardianId = positiveInt(body.legalGuardianId);
  const name = boundedText(body.name, 200);
  const dni = boundedText(body.dni, 20);
  if (!legalGuardianId || !name || !dni || (body.call !== "outgoing" && body.call !== "incoming")) return null;
  return { legalGuardianId, call: body.call, name, dni };
}

export function createApp({ db, routing, router, geocoder, solver, travelTime, pushSender: customPushSender, config }: {
  db: HealthDatabase;
  routing: RoutingHealth;
  router?: Router;
  geocoder?: Geocoder;
  // Solve VROOM problems and measure driving time for "Order"; without them ordering answers 503.
  solver?: VroomSolver;
  travelTime?: TravelTime;
  pushSender?: PushSender;
  config: AppConfig;
}) {
  if (!config.serverEpoch.trim()) throw new Error("SERVER_EPOCH is required");
  const healthTimeoutMs = config.healthTimeoutMs ?? 1000;
  const routeGapMinutes = config.routeGapMinutes ?? 60;
  const plannerSettings = config.planner ?? { rideTimeBufferMinutes: 5, speedFactors: [], earlyToleranceMinutes: 15 };
  const now = config.now ?? (() => new Date());
  const pushSender: PushSender = customPushSender ?? (async (sub, payload) => {
    if (!config.vapid) return;
    await webpush.sendNotification(
      {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      },
      payload,
      {
        vapidDetails: {
          subject: config.vapid.subject,
          publicKey: config.vapid.publicKey,
          privateKey: config.vapid.privateKey,
        },
        timeout: 4000,
      },
    );
  });
  // One geocoder request per second for the whole process; cached answers do not use the slot.
  const geocodeCache = new Map<string, GeocodeResult | null>();
  let nextGeocodeAt = 0;
  const totpLimiter = createAttemptLimiter(TOTP_FAILURE_LIMIT, LOGIN_WINDOW_MS, now);
  const trustedProxies = createTrustedProxies(config.trustedProxyCidrs ?? []);

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

  /** A signed-in Chofer with their profile; every /driver endpoint scopes its reads and writes to `driverId`. */
  async function requireDriver(context: Context) {
    const user = await authenticate(context);
    if (user instanceof Response) return user;
    if (user.role !== "driver") return context.json({ error: "Chofer role required" }, 403);
    const driver = await db.query("SELECT id FROM drivers WHERE user_id = $1", [user.id]) as QueryResult;
    if (!driver.rows[0]) return context.json({ error: "This account has no Chofer profile" }, 403);
    return { user, driverId: Number(driver.rows[0].id) };
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

  /**
   * The Chofer's own Recorrido, or the refusal; `anyDay` drops the today-and-tomorrow scope for what already happened.
   * Like the Chofer app, a Recorrido is the Chofer's when its latest Versión del plan is, so a change of Chofer moves it
   * with the next version.
   */
  async function ownRoute(context: Context, driverId: number, routeId: number, anyDay = false) {
    const route = await db.query(
      `SELECT ${ROUTE_OWNER_SQL} AS driver_id, to_char(dp.plan_date, 'YYYY-MM-DD') AS date
         FROM routes r JOIN daily_plans dp ON dp.id = r.daily_plan_id WHERE r.id = $1`,
      [routeId],
    ) as QueryResult;
    const row = route.rows[0];
    if (!row) return context.json({ error: "Recorrido not found" }, 404);
    if (Number(row.driver_id) !== driverId) return context.json({ error: NOT_OWN_ROUTE }, 403);
    if (!anyDay && !driverDays(now()).includes(String(row.date))) return context.json({ error: OUT_OF_DRIVER_SCOPE }, 403);
    return row;
  }

  /**
   * Locks the Recorrido and returns its status, refusing a Chofer who no longer owns its latest Versión del plan. The
   * check in ownRoute ran before the lock, and the Oficina may have given the Recorrido to another Chofer since; a
   * publication locks the Recorrido too, so the owner read after the lock holds until the commit.
   */
  async function lockOwnRoute(client: Queryable, driverId: number, routeId: number) {
    const route = (await client.query("SELECT status FROM routes WHERE id = $1 FOR UPDATE", [routeId]) as QueryResult).rows[0];
    if (!route) throw new PlanningError(404, "Recorrido not found");
    // A separate statement, so it reads the versions committed while it waited for the lock.
    const owner = (await client.query(`SELECT ${ROUTE_OWNER_SQL} AS driver_id FROM routes r WHERE r.id = $1`, [routeId]) as QueryResult).rows[0];
    if (Number(owner.driver_id) !== driverId) throw new PlanningError(403, NOT_OWN_ROUTE);
    return String(route.status);
  }

  /**
   * Stores a Marca the Chofer made from Recorrido `routeId`. It is never refused for being late or for a moved Traslado:
   * it is flagged and the Oficina gets an alert. A resent UUID returns the stored Marca; with other content it keeps the
   * first one and raises one conflict alert per different content.
   *
   * A Corrección (`corrects`) replaces the Traslado's latest Marca in force and never changes it. The Chofer corrects only
   * their own, within 2 minutes between the phone times; the Oficina (`driverId` null) any time, with `reason`.
   */
  async function recordMark(
    client: Queryable, chofer: { user: AuthenticatedUser; driverId: number | null }, routeId: number, fields: MarkFields, reason: string | null = null,
  ) {
    const seen = await client.query(
      `SELECT pv.id, EXISTS (SELECT 1 FROM plan_version_transfers pvt WHERE pvt.plan_version_id = pv.id AND pvt.transfer_id = $3) AS served
         FROM plan_versions pv WHERE pv.route_id = $1 AND pv.version = $2`,
      [routeId, fields.version, fields.transferId],
    ) as QueryResult;
    if (!seen.rows[0]) throw new PlanningError(404, "Versión del plan not found");
    if (!seen.rows[0].served) throw new PlanningError(404, "Traslado not found in this Versión del plan");
    // Locking the Traslado serialises its Marcas with the Oficina's moves, Ausencias and revocations.
    const transfer = (await client.query(
      "SELECT passenger_id, daily_plan_id, direction, trasbordo_stop FROM transfers WHERE id = $1 FOR UPDATE",
      [fields.transferId],
    ) as QueryResult).rows[0];
    const content = markContent({ ...fields, routeId });
    const stored = async () => (await client.query(`${MARK_SELECT_SQL} WHERE m.client_id = $1`, [fields.id]) as QueryResult).rows[0];
    const resend = async (row: Record<string, unknown>) => {
      // A UUID is the phone's own: another Chofer's Marca is neither shown nor compared.
      if (Number(row.driver_id) !== chofer.driverId) throw new PlanningError(409, "This Marca belongs to another Chofer");
      const mark = formatMark(row);
      if (markContent(mark) === content) return { status: 200 as const, mark };
      const { id: _, ...sent } = fields;
      await insertAlert(client, {
        kind: "mark_conflict", transferId: mark.transferId, routeId: mark.routeId, markId: Number(row.id), details: { sent: { ...sent, routeId } },
        dedupeKey: `mark_conflict:${row.id}:${createHash("sha256").update(content).digest("hex")}`,
      }, now());
      return { status: 200 as const, mark, conflict: true };
    };
    const existing = await stored();
    if (existing) return await resend(existing);
    let correctsMarkId: number | null = null;
    if (fields.corrects) {
      const target = (await client.query(
        `SELECT m.id, m.driver_id, m.phone_time,
                m.id = (SELECT e.id FROM marks e WHERE e.transfer_id = $2 AND ${MARK_IN_FORCE_SQL} ${LATEST_MARK_FIRST_SQL} LIMIT 1) AS latest
           FROM marks m WHERE m.client_id = $1 AND m.transfer_id = $2`,
        [fields.corrects, fields.transferId],
      ) as QueryResult).rows[0];
      if (!target) throw new PlanningError(404, "Marca not found on this Traslado");
      if (chofer.driverId !== null) {
        if (Number(target.driver_id) !== chofer.driverId) throw new PlanningError(403, "This Marca belongs to another Chofer");
        const elapsed = Math.abs(Date.parse(fields.phoneTime) - new Date(target.phone_time as string | Date).getTime());
        if (elapsed > CHOFER_CORRECTION_WINDOW_MS) throw new PlanningError(409, CALL_THE_OFFICE_TO_CORRECT);
      }
      if (target.latest !== true) throw new PlanningError(409, "Only the Traslado's latest Marca can be corrected");
      correctsMarkId = Number(target.id);
    }

    const flags: string[] = [];
    const placement = (await client.query(
      `SELECT EXISTS (SELECT 1 FROM stops WHERE transfer_id = $1 AND route_id = $2) AS assigned,
              EXISTS (SELECT 1 FROM plan_version_transfers pvt JOIN plan_versions pv ON pv.id = pvt.plan_version_id
                       WHERE pvt.transfer_id = $1 AND pv.route_id = $2
                         AND pv.version = (SELECT max(version) FROM plan_versions WHERE route_id = $2)) AS published`,
      [fields.transferId, routeId],
    ) as QueryResult).rows[0];
    if (!placement.assigned || !placement.published) flags.push("transfer_moved");
    // The close holds this Traslado's lock, so a Marca that waited on it sees the Recorrido Cerrado and the Oficina is told.
    const routeState = (await client.query("SELECT status FROM routes WHERE id = $1", [routeId]) as QueryResult).rows[0];
    if (routeState?.status === "cerrado") flags.push("route_closed");
    // A Trasbordo is recorded by the Oficina, which links both Marcas: a Chofer's own Subió or Entregado at its point is kept,
    // flagged, for the Oficina to correct it and record the Trasbordo.
    const handoverKind = transfer.trasbordo_stop === "pickup" ? "subio" : transfer.trasbordo_stop === "dropoff" ? "entregado" : null;
    if (chofer.driverId !== null && fields.kind === handoverKind) flags.push("trasbordo_unlinked");
    const receiver = fields.receiver;
    let authorized = false;
    if (receiver?.kind === "authorized_adult") {
      const adult = (await client.query("SELECT passenger_id, removed_at FROM authorized_adults WHERE id = $1", [receiver.adultId]) as QueryResult).rows[0];
      if (!adult) throw new PlanningError(400, "Invalid request");
      if (Number(adult.passenger_id) !== Number(transfer.passenger_id) || adult.removed_at !== null) flags.push("consent_mismatch");
    } else if (receiver?.kind === "destination") {
      const destination = await client.query("SELECT 1 FROM destinations WHERE id = $1", [receiver.destinationId]) as QueryResult;
      if (!destination.rows[0]) throw new PlanningError(400, "Invalid request");
    } else if (receiver?.kind === "other_adult") {
      const consent = (await client.query("SELECT other_adult_allowed FROM consents WHERE passenger_id = $1", [transfer.passenger_id]) as QueryResult).rows[0];
      let allowed = consent?.other_adult_allowed === true;
      if (receiver.authorizationId !== null) {
        const authorization = (await client.query(`${AUTHORIZATION_SELECT_SQL} WHERE oa.id = $1`, [receiver.authorizationId]) as QueryResult).rows[0];
        if (!authorization) throw new PlanningError(400, "Invalid request");
        const fits = Number(authorization.transfer_id) === fields.transferId && normalizeDni(String(authorization.dni)) === normalizeDni(receiver.dni);
        // A revocation the phone had not seen keeps the Entregado, flagged as a conflict; a used or expired one does not count.
        authorized = fits && (authorization.status === "valid" || authorization.status === "revoked");
        if (authorized && authorization.status === "revoked") flags.push("authorization_revoked");
        allowed ||= authorized;
      }
      if (!allowed) flags.push("consent_mismatch");
    }
    const serverTime = now();
    const inserted = await client.query(
      `INSERT INTO marks (client_id, transfer_id, plan_version_id, driver_id, session_id, kind, phone_time, server_time, latitude, longitude,
                          receiver_kind, receiver_adult_id, receiver_destination_id, receiver_name, receiver_dni, authorization_id, flags,
                          corrects_mark_id, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       ON CONFLICT (client_id) DO NOTHING RETURNING id`,
      [
        fields.id, fields.transferId, Number(seen.rows[0].id), chofer.driverId, chofer.user.session_id, fields.kind, fields.phoneTime, serverTime,
        fields.location?.lat ?? null, fields.location?.lng ?? null, receiver?.kind ?? null,
        receiver?.kind === "authorized_adult" ? receiver.adultId : null,
        receiver?.kind === "destination" ? receiver.destinationId : null,
        receiver?.kind === "other_adult" ? receiver.name : null,
        receiver?.kind === "other_adult" ? receiver.dni : null,
        receiver?.kind === "other_adult" ? receiver.authorizationId : null,
        JSON.stringify(flags),
        correctsMarkId,
        reason,
      ],
    ) as QueryResult;
    // Another request stored this UUID first.
    if (!inserted.rows[0]) return await resend((await stored())!);
    const markId = Number(inserted.rows[0].id);
    // The Traslado follows its Marca in force with the latest phone time, so one that arrives late does not undo a newer
    // one. With none left (every Marca undone) it is back where it was before the first: Planificado, or cancelled. Undoing a
    // Corrección puts back the state of the Marca it replaced.
    await client.query(
      `UPDATE transfers t SET status = COALESCE(
         (SELECT e.kind FROM marks e WHERE e.transfer_id = $1 AND ${MARK_IN_FORCE_SQL} ${LATEST_MARK_FIRST_SQL} LIMIT 1),
         CASE WHEN EXISTS (SELECT 1 FROM absences a WHERE a.transfer_id = $1) THEN 'cancelado_ausencia' ELSE 'planificado' END)
        WHERE t.id = $1`,
      [fields.transferId],
    );
    // Only a Chofer's Marca starts the Recorrido.
    const started = chofer.driverId === null ? { rows: [] } : await client.query(
      "UPDATE routes SET status = 'en_curso' WHERE id = $1 AND status = 'publicado' RETURNING id", [routeId],
    ) as QueryResult;
    if (started.rows[0]) {
      await appendChange(client, chofer.user.id, "route", String(routeId), "started", { status: "publicado" }, { status: "en_curso" });
    }
    const alert = { transferId: fields.transferId, routeId, markId };
    if (receiver?.kind === "other_adult") {
      await insertAlert(client, { ...alert, kind: "other_adult_handover", details: { authorized, name: receiver.name, dni: receiver.dni } }, serverTime);
    }
    if (flags.length) await insertAlert(client, { ...alert, kind: "mark_flagged", details: { reasons: flags } }, serverTime);
    if (fields.kind === "ausente" && transfer.direction === "entrada") {
      // The Oficina decides about the rest of the day: nothing is cancelled here.
      const remaining = await client.query(
        `SELECT t.id, t.direction, to_char(t.target_time, 'HH24:MI') AS target_time, d.name AS destination_name, o.name AS origin_name
           FROM transfers t JOIN destinations d ON d.id = t.destination_id LEFT JOIN destinations o ON o.id = t.origin_destination_id
          WHERE t.passenger_id = $1 AND t.daily_plan_id = $2 AND t.id <> $3 AND t.status = 'planificado'
          ORDER BY t.target_time, t.id`,
        [transfer.passenger_id, transfer.daily_plan_id, fields.transferId],
      ) as QueryResult;
      await insertAlert(client, {
        ...alert,
        kind: "absent_on_entrada",
        details: {
          remaining: remaining.rows.map((row) => ({
            transferId: Number(row.id),
            direction: String(row.direction),
            targetTime: String(row.target_time),
            destinationName: String(row.destination_name),
            originDestinationName: (row.origin_name as string | null) ?? null,
          })),
        },
      }, serverTime);
    }
    return { status: 201 as const, mark: formatMark((await stored())!) };
  }

  async function listDocuments(context: Context, kind: DocumentOwner["kind"]) {
    const actor = await requireOffice(context);
    if (actor instanceof Response) return actor;
    const id = parseId(context.req.param("id") ?? "");
    if (!id) return context.json({ error: "Invalid request" }, 400);
    const owner = await db.query(`SELECT id FROM ${kind === "vehicle" ? "vehicles" : "drivers"} WHERE id = $1`, [id]) as QueryResult;
    if (!owner.rows[0]) return context.json({ error: kind === "vehicle" ? "Vehicle not found" : "Driver not found" }, 404);
    const result = await db.query(`${DOCUMENT_SELECT_SQL} WHERE d.${kind}_id = $1 ORDER BY d.id`, [id]) as QueryResult;
    return context.json({ documents: result.rows.map(formatDocument) });
  }

  async function addDocument(context: Context, kind: DocumentOwner["kind"]) {
    const actor = await requireOffice(context);
    if (actor instanceof Response) return actor;
    const id = parseId(context.req.param("id") ?? "");
    const fields = parseDocument(await context.req.json().catch(() => null));
    if (!id) return context.json({ error: "Invalid request" }, 400);
    if ("error" in fields) return context.json({ error: fields.error }, 400);
    try {
      const document = await inTransaction(db, async (client) => {
        const owner = await client.query(`SELECT id FROM ${kind === "vehicle" ? "vehicles" : "drivers"} WHERE id = $1 FOR SHARE`, [id]) as QueryResult;
        if (!owner.rows[0]) throw new PlanningError(404, kind === "vehicle" ? "Vehicle not found" : "Driver not found");
        const inserted = await client.query(
          `INSERT INTO documents (${kind}_id, name, expires_on) VALUES ($1, $2, $3)
           RETURNING id, vehicle_id AS "vehicleId", driver_id AS "driverId", name, to_char(expires_on, 'YYYY-MM-DD') AS "expiresOn"`,
          [id, fields.name, fields.expiresOn],
        ) as QueryResult;
        const { id: documentId, ...after } = formatDocument(inserted.rows[0]);
        await appendChange(client, actor.id, "document", String(documentId), "created", null, after);
        return { id: documentId, ...after };
      });
      return context.json({ document }, 201);
    } catch (error) {
      if (isPostgresUniqueViolation(error)) return context.json({ error: "A document with this name already exists" }, 409);
      return planningFailure(context, error);
    }
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

  async function sendPushNudge(driverId: number, routeId: number, version: number) {
    try {
      const driverResult = await db.query("SELECT user_id FROM drivers WHERE id = $1", [driverId]) as QueryResult;
      const userId = driverResult.rows[0]?.user_id;
      if (!userId) return;

      const subsResult = await db.query(
        `SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth
           FROM push_subscriptions ps
           JOIN sessions s ON s.id = ps.session_id
          WHERE s.user_id = $1 AND s.revoked_at IS NULL`,
        [userId],
      ) as QueryResult;

      const payload = JSON.stringify({
        title: "Nueva versión del plan",
        body: `Se publicó la versión ${version} de tu recorrido`,
        routeId,
        version,
        url: `/?routeId=${routeId}`,
      });

      for (const row of subsResult.rows) {
        try {
          const res = await pushSender(
            {
              endpoint: String(row.endpoint),
              keys: { p256dh: String(row.p256dh), auth: String(row.auth) },
            },
            payload,
          );
          if (res && (res.statusCode === 404 || res.statusCode === 410)) {
            await db.query("DELETE FROM push_subscriptions WHERE id = $1", [row.id]).catch(() => undefined);
          }
        } catch (err: any) {
          const statusCode = err?.statusCode ?? err?.status;
          if (statusCode === 404 || statusCode === 410) {
            await db.query("DELETE FROM push_subscriptions WHERE id = $1", [row.id]).catch(() => undefined);
          }
        }
      }
    } catch {
      // Failure to deliver never blocks the publication
    }
  }

  /**
   * Publishes the Recorrido as its next Versión del plan. It reads the Recorrido and asks OSRM outside the transaction,
   * then publishes only if nothing it read changed meanwhile. With `onlyIfChanged` (the whole Plan diario), a Recorrido
   * equal to its latest version keeps that version instead of getting a new one. The caller revalidates the chain.
   */
  async function publishRoute(actorId: number, routeId: number, reason: string | null, onlyIfChanged = false) {
    const before = await loadPublicationSnapshot(db, routeId);
    if (!before.stops.length) throw new PlanningError(409, "A Recorrido without Paradas cannot be published");
    const expected = publicationSignature(before);
    const latest = onlyIfChanged ? await latestVersionSignature(db, routeId) : null;
    if (latest?.signature === expected) {
      const [version] = await loadPlanVersions(db, "pv.route_id = $1 AND pv.version = $2", [routeId, latest.version]);
      return { created: false, version };
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
      // The Traslados before the Recorrido, as a Marca locks them, so no Marca lands between this read and the commit.
      await client.query("SELECT id FROM transfers WHERE id = ANY($1::int[]) ORDER BY id FOR SHARE", [before.transfers.map((transfer) => transfer.id)]);
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
      const locked = lockedLegs(snapshot, legs);
      locked.forEach((leg, index) => {
        legs[index] = { distanceMeters: index === 0 ? 0 : leg.distanceMeters, durationSeconds: index === 0 ? 0 : leg.durationSeconds };
      });
      const planned = plannedMinutes(snapshot, legs, locked.map((leg) => leg.plannedMinutes));
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
      return { created: true, version, driverId };
    });
    const [version] = await loadPlanVersions(db, "pv.route_id = $1 AND pv.version = $2", [routeId, published.version]);
    if (published.created && published.driverId) {
      void sendPushNudge(Number(published.driverId), routeId, published.version).catch(() => undefined);
    }
    return { created: published.created, version };
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

  /**
   * After Recorrido k is published, every planned Trasbordo whose leg A it serves and whose leg B is still to be picked up
   * in a published Recorrido is revalidated against k's new times: leg A must reach the point by t + 5 and before leg B's
   * planned pickup, and the whole chain (from A's Subió, or its pickup in k, to the end of B's drop-off) must fit the
   * Tiempo máximo a bordo. The
   * Oficina is warned through the change log and the answer; leg B's Recorrido is never republished here.
   */
  async function revalidateTrasbordos(actorId: number, routeId: number): Promise<CascadeWarning[]> {
    const chains = await db.query(
      `WITH a AS (
         SELECT l.transfer_id, l.kind, EXTRACT(EPOCH FROM l.planned_time) / 60 AS minutes, pv.version
           FROM plan_version_legs l JOIN plan_versions pv ON pv.id = l.plan_version_id
          WHERE pv.route_id = $1 AND pv.version = (SELECT max(version) FROM plan_versions WHERE route_id = $1))
       SELECT b.id, p.name, p.max_ride_time_minutes, p.dropoff_duration_minutes, a_up.version AS from_version,
              EXTRACT(EPOCH FROM b.trasbordo_time) / 60 AS t, ${rideStartMinutesSql("b")} AS ride_start,
              a_down.minutes AS a_dropoff,
              pvb.route_id, pvb.version,
              (SELECT EXTRACT(EPOCH FROM l.planned_time) / 60 FROM plan_version_legs l
                WHERE l.plan_version_id = pvb.id AND l.transfer_id = b.id AND l.kind = 'pickup') AS b_pickup,
              (SELECT EXTRACT(EPOCH FROM l.planned_time) / 60 FROM plan_version_legs l
                WHERE l.plan_version_id = pvb.id AND l.transfer_id = b.id AND l.kind = 'dropoff') AS b_dropoff
         FROM a a_up
         JOIN a a_down ON a_down.transfer_id = a_up.transfer_id AND a_down.kind = 'dropoff'
         JOIN transfers b ON b.chained_from_transfer_id = a_up.transfer_id AND b.status = 'planificado'
         JOIN passengers p ON p.id = b.passenger_id
         JOIN stops sb ON sb.transfer_id = b.id AND sb.kind = 'pickup'
         JOIN LATERAL (SELECT id, route_id, version FROM plan_versions WHERE route_id = sb.route_id ORDER BY version DESC LIMIT 1) pvb ON true
        WHERE a_up.kind = 'pickup'
          AND EXISTS (SELECT 1 FROM plan_version_transfers pvt WHERE pvt.plan_version_id = pvb.id AND pvt.transfer_id = b.id)
        ORDER BY b.id`,
      [routeId],
    ) as QueryResult;
    const clock = (minutes: number) => clockOfSeconds(Math.round(minutes * 60)).slice(0, 5);
    const warnings: CascadeWarning[] = [];
    for (const row of chains.rows) {
      const [t, aDropoff, bPickup] = [Number(row.t), Number(row.a_dropoff), Number(row.b_pickup)];
      const ride = Number(row.b_dropoff) + Number(row.dropoff_duration_minutes) - Number(row.ride_start);
      const problems: string[] = [];
      if (aDropoff > Math.min(t + TRASBORDO_WINDOW_MINUTES, bPickup) + 1e-6) {
        problems.push(`Leg A of ${row.name} reaches the Trasbordo point at ${clock(aDropoff)}, after ${clock(Math.min(t + TRASBORDO_WINDOW_MINUTES, bPickup))}`);
      }
      if (ride > Number(row.max_ride_time_minutes) + 1e-6) {
        problems.push(`${row.name} rides ${Math.round(ride)} min from the start of leg A, over the Tiempo máximo a bordo of ${row.max_ride_time_minutes} min`);
      }
      const problem = problems.length ? problems.join("; ") : null;
      const warning = { routeId: Number(row.route_id), version: Number(row.version), fromRouteId: routeId, ok: problem === null, problem };
      await appendChange(db, actorId, "route", String(warning.routeId), "trasbordo_revalidated", null, {
        version: warning.version, transferId: Number(row.id), fromRouteId: routeId, fromVersion: Number(row.from_version), ok: warning.ok, problem,
      });
      warnings.push(warning);
    }
    return warnings;
  }

  /**
   * Moves the Traslado's Paradas of `kinds` right after the Recorrido's done Paradas, where a Trasbordo end that just
   * happened belongs (and, for a leg B created there, its drop-off next); the rest keep their order. Only renumbers
   * (dropping the stored times) when they are not there already.
   */
  async function placeAfterDone(client: Queryable, routeId: number, transferId: number, kinds: ("pickup" | "dropoff")[]) {
    const stops = (await client.query(
      "SELECT s.id, s.transfer_id, s.kind, t.status FROM stops s JOIN transfers t ON t.id = s.transfer_id WHERE s.route_id = $1 ORDER BY s.position, s.id",
      [routeId],
    ) as QueryResult).rows;
    const moved = kinds.map((kind) => stops.find((stop) => Number(stop.transfer_id) === transferId && stop.kind === kind)!);
    const rest = stops.filter((stop) => !moved.includes(stop));
    const done = rest.filter((stop) => isDoneStop(String(stop.kind), String(stop.status))).length;
    const order = [...rest.slice(0, done), ...moved, ...rest.slice(done)].map((stop) => Number(stop.id));
    if (order.join() === stops.map((stop) => Number(stop.id)).join()) return;
    await client.query("UPDATE stops SET position = o.ord FROM unnest($1::int[]) WITH ORDINALITY AS o(id, ord) WHERE stops.id = o.id", [order]);
    await settleStops(client, routeId);
  }

  /**
   * A Trasbordo: the Pasajero on board (Subió) on leg A is handed to the Chofer of Recorrido `toRouteId` at `point`, now.
   * It records, linked, an Entregado to that Chofer (Receptor kind driver) in A's Recorrido and a Subió of leg B in the
   * receiving one, at the same place and time. A planned Trasbordo already has leg B there; otherwise (a breakdown) leg B
   * is created, from the point to A's destination, in the receiving Recorrido after its done Paradas. Leg A may itself have
   * started at a Trasbordo: the chain then gets one more leg. Repeating the same Trasbordo returns the recorded one
   * (`created: false`).
   */
  async function recordTrasbordo(client: Queryable, actor: AuthenticatedUser, transferId: number, toRouteId: number, point: Point | null) {
    const leg = (await client.query(
      `SELECT t.*, s.route_id FROM transfers t LEFT JOIN stops s ON s.transfer_id = t.id AND s.kind = 'pickup'
        WHERE t.id = $1 FOR UPDATE OF t`,
      [transferId],
    ) as QueryResult).rows[0];
    if (!leg) throw new PlanningError(404, "Traslado not found");
    const next = (await client.query(
      `SELECT n.id, s.route_id, EXISTS (SELECT 1 FROM marks m WHERE m.transfer_id = n.id AND m.trasbordo_mark_id IS NOT NULL) AS handed
         FROM transfers n LEFT JOIN stops s ON s.transfer_id = n.id AND s.kind = 'pickup' WHERE n.chained_from_transfer_id = $1 FOR UPDATE OF n`,
      [transferId],
    ) as QueryResult).rows[0];
    if (next?.handed && Number(next.route_id) === toRouteId) {
      return { created: false, fromRouteId: Number(leg.route_id), legBId: Number(next.id), marks: await trasbordoMarks(client, Number(next.id)) };
    }
    if (leg.status !== "subio") throw new PlanningError(409, "Only a Pasajero on board (Subió) can be handed over in a Trasbordo");
    if (next && Number(next.route_id) !== toRouteId) throw new PlanningError(409, "The planned Trasbordo of this Traslado hands it over in another Recorrido");
    const fromRouteId = Number(leg.route_id);
    if (fromRouteId === toRouteId) throw new PlanningError(409, "A Trasbordo hands the Pasajero over to another Recorrido");
    for (const routeId of [fromRouteId, toRouteId].sort((a, b) => a - b)) {
      const route = await lockRoute(client, routeId);
      if (route.dailyPlanId !== Number(leg.daily_plan_id)) throw new PlanningError(409, "The Recorrido belongs to another Plan diario");
    }
    const latest = async (routeId: number) => (await client.query(
      `SELECT pv.id, pv.driver_id, r.status FROM routes r LEFT JOIN plan_versions pv ON pv.route_id = r.id
        WHERE r.id = $1 ORDER BY pv.version DESC LIMIT 1`,
      [routeId],
    ) as QueryResult).rows[0];
    const [from, to] = [await latest(fromRouteId), await latest(toRouteId)];
    if (to.id === null || !["publicado", "en_curso"].includes(String(to.status))) {
      throw new PlanningError(409, "The receiving Recorrido must be published and not closed");
    }
    const place = point ?? (next ? { lat: Number(leg.trasbordo_latitude), lng: Number(leg.trasbordo_longitude) } : null);
    if (!place) throw new PlanningError(400, "A Trasbordo needs the place where it happens");
    const at = now();
    let legBId: number;
    if (next) {
      legBId = Number(next.id);
      // Both legs' end is where the Trasbordo happened, also when it was not the planned point.
      await client.query("UPDATE transfers SET trasbordo_latitude = $3, trasbordo_longitude = $4 WHERE id IN ($1, $2)", [transferId, legBId, place.lat, place.lng]);
    } else {
      const localTime = new Intl.DateTimeFormat("en-GB", { timeZone: LOCAL_TIME_ZONE, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(at);
      // A leg that started at a Trasbordo keeps that end: it now ends where the new leg starts (NEXT_LEG_JOIN_SQL).
      if (leg.trasbordo_stop !== "pickup") {
        await client.query(
          "UPDATE transfers SET trasbordo_stop = 'dropoff', trasbordo_latitude = $2, trasbordo_longitude = $3, trasbordo_time = $4 WHERE id = $1",
          [transferId, place.lat, place.lng, localTime],
        );
      }
      legBId = Number((await client.query(
        `INSERT INTO transfers (daily_plan_id, passenger_id, direction, destination_id, target_time, companions,
                                chained_from_transfer_id, trasbordo_stop, trasbordo_latitude, trasbordo_longitude, trasbordo_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pickup', $8, $9, $10) RETURNING id`,
        [leg.daily_plan_id, leg.passenger_id, leg.direction, leg.destination_id, leg.target_time, leg.companions, transferId, place.lat, place.lng, localTime],
      ) as QueryResult).rows[0].id);
      await appendStops(client, toRouteId, legBId);
    }
    const insertMark = async (fields: { transferId: number; versionId: unknown; driverId: unknown; kind: string; receiverDriverId: unknown; trasbordoMarkId: number | null }) =>
      Number((await client.query(
        `INSERT INTO marks (client_id, transfer_id, plan_version_id, driver_id, session_id, kind, phone_time, server_time, latitude, longitude,
                            receiver_kind, receiver_driver_id, trasbordo_mark_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [randomUUID(), fields.transferId, fields.versionId, fields.driverId, actor.session_id, fields.kind, at, place.lat, place.lng,
          fields.receiverDriverId === null ? null : "driver", fields.receiverDriverId, fields.trasbordoMarkId],
      ) as QueryResult).rows[0].id);
    const delivered = await insertMark({ transferId, versionId: from.id, driverId: from.driver_id, kind: "entregado", receiverDriverId: to.driver_id, trasbordoMarkId: null });
    await insertMark({ transferId: legBId, versionId: to.id, driverId: to.driver_id, kind: "subio", receiverDriverId: null, trasbordoMarkId: delivered });
    await client.query("UPDATE transfers SET status = CASE id WHEN $1 THEN 'entregado' ELSE 'subio' END WHERE id IN ($1, $2)", [transferId, legBId]);
    await placeAfterDone(client, fromRouteId, transferId, ["dropoff"]);
    await placeAfterDone(client, toRouteId, legBId, next ? ["pickup"] : ["pickup", "dropoff"]);
    const handover = { fromRouteId, toRouteId, legAId: transferId, legBId, lat: place.lat, lng: place.lng, at: at.toISOString() };
    await appendChange(client, actor.id, "transfer", String(transferId), "trasbordo", { status: "subio", routeId: fromRouteId }, { status: "entregado", ...handover });
    await appendChange(client, actor.id, "transfer", String(legBId), "trasbordo", { status: next ? "planificado" : null }, { status: "subio", routeId: toRouteId, ...handover });
    return { created: true, fromRouteId, legBId, marks: await trasbordoMarks(client, legBId) };
  }

  /** The linked Marcas of the Trasbordo that started leg `legBId`: the Entregado to its Chofer and the Subió that continues it. */
  async function trasbordoMarks(client: Queryable, legBId: number) {
    const subio = (await client.query(`${MARK_SELECT_SQL} WHERE m.transfer_id = $1 AND m.trasbordo_mark_id IS NOT NULL`, [legBId]) as QueryResult).rows[0];
    const entregado = (await client.query(`${MARK_SELECT_SQL} WHERE m.client_id = $1`, [subio.trasbordo_client_id]) as QueryResult).rows[0];
    return { entregado: formatMark(entregado), subio: formatMark(subio) };
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
      const ip = clientIp(context, config, trustedProxies);
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
          if (session) {
            await client.query("DELETE FROM push_subscriptions WHERE session_id = $1", [session.id]);
            await appendChange(client, Number(session.user_id), "session", String(session.id), "revoked", { active: true }, { active: false });
          }
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
        await client.query("DELETE FROM push_subscriptions WHERE session_id IN (SELECT id FROM sessions WHERE user_id = $1)", [id]);
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
        await client.query("DELETE FROM push_subscriptions WHERE session_id IN (SELECT id FROM sessions WHERE user_id = $1)", [id]);
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
        await client.query("DELETE FROM push_subscriptions WHERE session_id = $1", [sessionId]);
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
    // After revoking a lost or stolen phone, the Traslados of that Chofer today with no Marca in force on the server: what the
    // Oficina has to rebuild. The phone's queue is never read; an account without Recorridos has none.
    .get("/users/:id/unconfirmed-transfers", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const id = parseId(context.req.param("id"));
      if (!id) return context.json({ error: "Invalid request" }, 400);
      const exists = await db.query("SELECT id FROM users WHERE id = $1", [id]) as QueryResult;
      if (!exists.rows.length) return context.json({ error: "User not found" }, 404);
      const [date] = driverDays(now());
      // Each Recorrido as its latest Versión del plan, the one the Chofer's phone shows.
      const result = await db.query(
        `SELECT t.id AS transfer_id, latest.route_id, p.name AS passenger_name, t.direction, to_char(t.target_time, 'HH24:MI') AS target_time,
                d.name AS destination_name
           FROM (SELECT DISTINCT ON (pv.route_id) pv.id, pv.route_id, pv.driver_id
                   FROM plan_versions pv JOIN routes r ON r.id = pv.route_id JOIN daily_plans dp ON dp.id = r.daily_plan_id
                  WHERE dp.plan_date = $2 ORDER BY pv.route_id, pv.version DESC) latest
           JOIN drivers dr ON dr.id = latest.driver_id
           JOIN plan_version_transfers pvt ON pvt.plan_version_id = latest.id
           JOIN transfers t ON t.id = pvt.transfer_id
           JOIN passengers p ON p.id = t.passenger_id
           JOIN destinations d ON d.id = t.destination_id
          WHERE dr.user_id = $1 AND t.status = 'planificado'
          ORDER BY t.target_time, t.id`,
        [id, date],
      ) as QueryResult;
      return context.json({
        date,
        transfers: result.rows.map((row) => ({
          transferId: Number(row.transfer_id),
          routeId: Number(row.route_id),
          passengerName: String(row.passenger_name),
          direction: String(row.direction),
          targetTime: String(row.target_time),
          destinationName: String(row.destination_name),
        })),
      });
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
          await seedDocuments(client, actor.id, { kind: "vehicle", id });
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
          await seedDocuments(client, actor.id, { kind: "driver", id });
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
    .get("/vehicles/:id/documents", (context) => listDocuments(context, "vehicle"))
    .post("/vehicles/:id/documents", (context) => addDocument(context, "vehicle"))
    .get("/drivers/:id/documents", (context) => listDocuments(context, "driver"))
    .post("/drivers/:id/documents", (context) => addDocument(context, "driver"))
    // Replaces the document's name and date; the same values again change nothing and add no log entry.
    .patch("/documents/:id", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const id = parseId(context.req.param("id"));
      const body = await context.req.json().catch(() => null);
      const fields = parseDocument(body);
      if (!id) return context.json({ error: "Invalid request" }, 400);
      if ("error" in fields) return context.json({ error: fields.error }, 400);
      // Both fields are replaced, so a missing date is refused rather than taken as "no date".
      if (!isObject(body) || !("expiresOn" in body)) {
        return context.json({ error: "Send expiresOn: a date as YYYY-MM-DD, or null for no date" }, 400);
      }
      try {
        const document = await inTransaction(db, async (client) => {
          const locked = await client.query(`${DOCUMENT_SELECT_SQL} WHERE d.id = $1 FOR UPDATE`, [id]) as QueryResult;
          if (!locked.rows[0]) throw new PlanningError(404, "Document not found");
          const { id: _, ...before } = formatDocument(locked.rows[0]);
          const after = { ...before, ...fields };
          if (before.name !== after.name || before.expiresOn !== after.expiresOn) {
            await client.query("UPDATE documents SET name = $1, expires_on = $2 WHERE id = $3", [fields.name, fields.expiresOn, id]);
            await appendChange(client, actor.id, "document", String(id), "updated", before, after);
          }
          return { id, ...after };
        });
        return context.json({ document });
      } catch (error) {
        if (isPostgresUniqueViolation(error)) return context.json({ error: "A document with this name already exists" }, 409);
        return planningFailure(context, error);
      }
    })
    .delete("/documents/:id", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const id = parseId(context.req.param("id"));
      if (!id) return context.json({ error: "Invalid request" }, 400);
      try {
        await inTransaction(db, async (client) => {
          const locked = await client.query(`${DOCUMENT_SELECT_SQL} WHERE d.id = $1 FOR UPDATE`, [id]) as QueryResult;
          if (!locked.rows[0]) throw new PlanningError(404, "Document not found");
          await client.query("DELETE FROM documents WHERE id = $1", [id]);
          const { id: _, ...before } = formatDocument(locked.rows[0]);
          await appendChange(client, actor.id, "document", String(id), "removed", before, null);
        });
        return context.body(null, 204);
      } catch (error) {
        return planningFailure(context, error);
      }
    })
    // The Vencimientos panel: documents expired or expiring within EXPIRY_ALERT_DAYS of today in Tucumán, by date, and
    // apart the documents with no date, which are neither expired nor counted.
    .get("/expiries", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const today = localDate(now());
      const result = await db.query(
        `SELECT d.id, d.name, to_char(d.expires_on, 'YYYY-MM-DD') AS "expiresOn", d.expires_on - $1::date AS "daysLeft",
                d.vehicle_id AS "vehicleId", d.driver_id AS "driverId", COALESCE(v.plate, dr.name) AS "ownerLabel"
           FROM documents d LEFT JOIN vehicles v ON v.id = d.vehicle_id LEFT JOIN drivers dr ON dr.id = d.driver_id
          WHERE d.expires_on IS NULL OR d.expires_on <= $1::date + $2::int
          ORDER BY d.expires_on NULLS LAST, "ownerLabel", d.id`,
        [today, EXPIRY_ALERT_DAYS],
      ) as QueryResult;
      const items = result.rows.map((row) => ({
        id: Number(row.id),
        name: String(row.name),
        expiresOn: (row.expiresOn as string | null) ?? null,
        daysLeft: nullableNumber(row.daysLeft),
        owner: row.vehicleId === null
          ? { kind: "driver" as const, id: Number(row.driverId), label: String(row.ownerLabel) }
          : { kind: "vehicle" as const, id: Number(row.vehicleId), label: String(row.ownerLabel) },
      }));
      return context.json({
        today,
        documents: items.filter((item) => item.expiresOn !== null),
        undated: items.filter((item) => item.expiresOn === null),
      });
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
      const adults = await db.query(
        `${AUTHORIZED_ADULT_SELECT_SQL} WHERE passenger_id = $1 AND removed_at IS NULL ORDER BY lower(name), id`,
        [id],
      ) as QueryResult;
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
          const locked = await client.query(`${AUTHORIZED_ADULT_SELECT_SQL} WHERE id = $1 AND removed_at IS NULL FOR UPDATE`, [id]) as QueryResult;
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
          const locked = await client.query(`${AUTHORIZED_ADULT_SELECT_SQL} WHERE id = $1 AND removed_at IS NULL FOR UPDATE`, [id]) as QueryResult;
          if (!locked.rows[0]) throw new PlanningError(404, "Adulto autorizado not found");
          if (await signedConsent(client, id)) throw new PlanningError(409, SIGNER_MUST_STAY);
          // A logical delete: a Marca or an Autorización puntual may still name this adult.
          await client.query("UPDATE authorized_adults SET removed_at = $2 WHERE id = $1", [id, now()]);
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
            "SELECT legal_guardian FROM authorized_adults WHERE id = $1 AND passenger_id = $2 AND removed_at IS NULL FOR SHARE",
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
    .get("/daily-plans/:date/live", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const date = parsePlanDate(context.req.param("date"));
      if (!date) return context.json({ error: "Invalid request" }, 400);
      const live = await loadLiveDailyPlan(db, router, date);
      return live ? context.json(live) : context.json({ error: "Plan diario not found" }, 404);
    })
    .post("/daily-plans/:date/copy-last-weekday", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const date = parsePlanDate(context.req.param("date"));
      if (!date) return context.json({ error: "Invalid request" }, 400);
      try {
        const result = await inTransaction(db, async (client) => {
          return await copyFromLastWeekday(client, actor.id, date);
        });
        return context.json(result, 201);
      } catch (error) {
        return planningFailure(context, error);
      }
    })
    .get("/daily-plans/:date/print", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const date = parsePlanDate(context.req.param("date"));
      if (!date) return context.json({ error: "Invalid request" }, 400);
      const result = await loadDailyPlanPrint(db, date);
      if (!result) return context.json({ error: "Plan diario not found" }, 404);
      if (result.status === 409) return context.json({ error: result.error, unpublishedTransfers: result.unpublishedTransfers }, 409);
      return context.json(result.data);
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
            `SELECT t.daily_plan_id, t.status, t.companions, s.route_id, t.origin_destination_id, t.trasbordo_stop,
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
            if (row.trasbordo_stop !== null) throw new PlanningError(409, "A Trasbordo leg is pinned to its Recorrido");
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
    // A planned Trasbordo: the Oficina fixes the place and time t, and the Traslado is split into leg A (to the point, in
    // fromRouteId) and leg B (from the point, in toRouteId), each pinned to its Recorrido and held there to [t, t + 5].
    // The engine chooses neither the place nor the time.
    .post("/transfers/:id/planned-trasbordo", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const id = parseId(context.req.param("id"));
      const body = await context.req.json().catch(() => null);
      const lat = isObject(body) ? coordinate(body.lat, 90) : null;
      const lng = isObject(body) ? coordinate(body.lng, 180) : null;
      const time = isObject(body) ? parseLocalTime(body.time) : null;
      const fromRouteId = isObject(body) ? positiveInt(body.fromRouteId) : null;
      const toRouteId = isObject(body) ? positiveInt(body.toRouteId) : null;
      if (!id || lat === null || lng === null || !time || !fromRouteId || !toRouteId) return context.json({ error: "Invalid request" }, 400);
      if (fromRouteId === toRouteId) return context.json({ error: "The two legs of a Trasbordo go in two different Recorridos" }, 400);
      try {
        const legs = await inTransaction(db, async (client) => {
          const leg = (await client.query(
            `SELECT t.*, to_char(t.target_time, 'HH24:MI') AS target, to_char(t.exit_time, 'HH24:MI') AS exit, s.route_id,
                    EXISTS (SELECT 1 FROM transfers n WHERE n.chained_from_transfer_id = t.id) AS chained
               FROM transfers t LEFT JOIN stops s ON s.transfer_id = t.id AND s.kind = 'pickup' WHERE t.id = $1 FOR UPDATE OF t`,
            [id],
          ) as QueryResult).rows[0];
          if (!leg) throw new PlanningError(404, "Traslado not found");
          if (leg.trasbordo_stop !== null || leg.chained) throw new PlanningError(409, "This Traslado already has a Trasbordo");
          if (leg.status !== "planificado") throw new PlanningError(409, "Only a Planificado Traslado can get a planned Trasbordo");
          const within = leg.direction === "entrada" ? time < String(leg.target) && (leg.exit === null || time > String(leg.exit)) : time > String(leg.target);
          if (!within) throw new PlanningError(400, "The Trasbordo happens during the Traslado: before an entrada's target time, after a salida's");
          await assertConsent(client, [id]);
          const currentRouteId = nullableNumber(leg.route_id);
          for (const routeId of [...new Set([currentRouteId, fromRouteId, toRouteId].filter((value) => value !== null))].sort((a, b) => a - b)) {
            const route = await lockRoute(client, routeId);
            if (route.dailyPlanId !== Number(leg.daily_plan_id)) throw new PlanningError(409, "The Recorrido belongs to another Plan diario");
          }
          await removeStops(client, id);
          await client.query(
            "UPDATE transfers SET trasbordo_stop = 'dropoff', trasbordo_latitude = $2, trasbordo_longitude = $3, trasbordo_time = $4 WHERE id = $1",
            [id, lat, lng, time],
          );
          const legBId = Number((await client.query(
            `INSERT INTO transfers (daily_plan_id, passenger_id, direction, destination_id, target_time, companions,
                                    chained_from_transfer_id, trasbordo_stop, trasbordo_latitude, trasbordo_longitude, trasbordo_time)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'pickup', $8, $9, $10) RETURNING id`,
            [leg.daily_plan_id, leg.passenger_id, leg.direction, leg.destination_id, leg.target_time, leg.companions, id, lat, lng, time],
          ) as QueryResult).rows[0].id);
          for (const [routeId, transferId] of [[fromRouteId, id], [toRouteId, legBId]]) {
            await appendStops(client, routeId, transferId);
            await settleStops(client, routeId);
          }
          const trasbordo = { lat, lng, time, fromRouteId, toRouteId, legAId: id, legBId };
          await appendChange(client, actor.id, "transfer", String(id), "trasbordo_planned", { routeId: currentRouteId }, { routeId: fromRouteId, ...trasbordo });
          await appendChange(client, actor.id, "transfer", String(legBId), "created", null, { routeId: toRouteId, chainedFromTransferId: id, ...trasbordo });
          return { legA: await getTransferById(client, id), legB: await getTransferById(client, legBId) };
        });
        return context.json({ ...legs, ...await warningsAfterCommit(db, [fromRouteId, toRouteId]) }, 201);
      } catch (error) {
        return planningFailure(context, error);
      }
    })
    // A Trasbordo as it happens (a breakdown, or a planned one): see recordTrasbordo. Then the receiving Recorrido is
    // published again, validated with the ride counted from the original Subió; with violations it needs overrideReason,
    // and a refused publication leaves the Marcas recorded and says why in `publication`.
    .post("/transfers/:id/trasbordo", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const id = parseId(context.req.param("id"));
      const body = await context.req.json().catch(() => null);
      const toRouteId = isObject(body) ? positiveInt(body.routeId) : null;
      const hasPoint = isObject(body) && (body.lat !== undefined || body.lng !== undefined);
      const point = hasPoint ? { lat: coordinate(body.lat, 90), lng: coordinate(body.lng, 180) } : null;
      const reason = isObject(body) ? body.overrideReason ?? null : null;
      if (!id || !toRouteId || (point && (point.lat === null || point.lng === null))
        || (reason !== null && (typeof reason !== "string" || reason.length > 1000))) {
        return context.json({ error: "Invalid request" }, 400);
      }
      try {
        const result = await inTransaction(db, async (client) => await recordTrasbordo(client, actor, id, toRouteId, point as Point | null));
        let publication: Record<string, unknown>;
        try {
          publication = { version: (await publishRoute(actor.id, toRouteId, reason?.trim() || null, true)).version };
        } catch (error) {
          if (!(error instanceof PlanningError)) throw error;
          publication = { error: error.message, ...error.extra };
        }
        return context.json({
          legA: await getTransferById(db, id),
          legB: await getTransferById(db, result.legBId),
          marks: result.marks,
          publication,
        }, result.created ? 201 : 200);
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
        return context.json({ route, ...await warningsAfterCommit(db, [route.id]) }, 201);
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
      const driverId = isObject(body) && body.driverId !== undefined ? positiveInt(body.driverId) : undefined;
      const ends = isObject(body) ? parseRouteEnds(body) : null;
      if (!id || vehicleId === null || driverId === null || !ends
        || (vehicleId === undefined && driverId === undefined && !ends.start && ends.endKind === undefined)) {
        return context.json({ error: "Invalid request" }, 400);
      }
      try {
        const route = await inTransaction(db, async (client) => {
          await lockRoute(client, id);
          const before: Record<string, unknown> = await getRouteById(client, id);
          // The Chofer is locked before the Vehículo, as publishing does. The Vehículo and a start or end the Oficina set are
          // kept; the default start and end follow the new Chofer, since "Order" derives them from the Recorrido's Chofer.
          if (driverId !== undefined && driverId !== before.driverId) await assertCanChangeDriver(client, before, driverId);
          if (vehicleId !== undefined) await assertActiveUsualVehicle(client, vehicleId);
          const after: Record<string, unknown> = {
            driverId: driverId ?? before.driverId,
            vehicleId: vehicleId ?? before.vehicleId,
            startKind: ends.start ? ends.start.kind : before.startKind,
            startLat: ends.start ? ends.start.lat : before.startLat,
            startLng: ends.start ? ends.start.lng : before.startLng,
            endKind: ends.endKind !== undefined ? ends.endKind : before.endKind,
          };
          const changed = Object.keys(after).filter((key) => after[key] !== before[key]);
          if (changed.length) {
            await client.query(
              `UPDATE routes SET driver_id = $1, vehicle_id = $2, start_kind = $3, start_latitude = $4, start_longitude = $5, end_kind = $6
                WHERE id = $7`,
              [after.driverId, after.vehicleId, after.startKind, after.startLat, after.startLng, after.endKind, id],
            );
            await appendChange(
              client, actor.id, "route", String(id), "updated",
              Object.fromEntries(changed.map((key) => [key, before[key]])),
              Object.fromEntries(changed.map((key) => [key, after[key]])),
            );
          }
          return await getRouteById(client, id);
        });
        return context.json({ route, ...await warningsAfterCommit(db, [id]) });
      } catch (error) {
        return planningFailure(context, error);
      }
    })
    // "Order": the engine orders the Borrador Recorrido's Paradas and plans their times. Traslados it cannot place leave
    // the Recorrido with their reason, so every Traslado is in the order or in `unassigned`. The engine runs outside the
    // transaction; the result is applied only if nothing the engine was given changed meanwhile.
    .post("/routes/:id/order", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const id = parseId(context.req.param("id"));
      if (!id) return context.json({ error: "Invalid request" }, 400);
      if (!solver || !travelTime) return context.json({ error: "The routing engine is not configured" }, 503);
      try {
        const { route, rows: all, neighbours, stops: current, latestLegs, key } = await orderInputKey(db, id);
        if (!route) throw new PlanningError(404, "Recorrido not found");
        if (route.status !== "borrador" && route.status !== "en_curso") {
          throw new PlanningError(409, "Only a Borrador or En curso Recorrido can be ordered");
        }
        // En curso, what happened stays: the done Paradas go first as they are, and an Ausente's drop-off, which never
        // happens, right after them. The engine gets the Planificados and, as drop-offs only, the Pasajeros on board.
        const status = new Map(all.map((row) => [Number(row.id), String(row.status)]));
        const locked = current.filter((stop) => isDoneStop(stop.kind, status.get(stop.transferId)!));
        const voided = current.filter((stop) => stop.kind === "dropoff" && status.get(stop.transferId) === "ausente");
        const rows = all.filter((row) => row.status === "planificado" || row.status === "subio");
        // Entradas from another Destino stored before the exit time existed cannot be planned until the Oficina sets it.
        const withoutExit = rows.filter((row) => row.status === "planificado" && row.o_lat !== null && row.exit_time === null);
        if (withoutExit.length) {
          const names = withoutExit.map((row) => `${row.name} (Traslado ${row.id})`).join(", ");
          throw new PlanningError(409, `Set the exit time from the first Destino of: ${names}`);
        }
        // Leg A of a planned Trasbordo is solved first: leg B's ride counts from A's planned pickup.
        const unsolved = rows.filter((row) => row.trasbordo_stop === "pickup" && row.ride_start_minutes === null);
        if (unsolved.length) {
          const names = unsolved.map((row) => `${row.name} (Traslado ${row.id})`).join(", ");
          throw new PlanningError(409, `Order the Recorrido of leg A of the Trasbordo first: ${names}`);
        }
        let plan: PlanResult = { stops: [], unassigned: [] };
        if (rows.length && locked.length) {
          // The Recorrido goes on from its last done Parada, once it ended and every Pasajero on board got on.
          const last = locked.at(-1)!;
          const lastRow = all.find((row) => Number(row.id) === last.transferId)!;
          const lastLeg = latestLegs.find((leg) => leg.transferId === last.transferId && leg.kind === last.kind);
          const service = Number(last.kind === "pickup" ? lastRow.pickup_duration_minutes : lastRow.dropoff_duration_minutes);
          const startMinutes = Math.ceil(Math.max(
            lastLeg ? lastLeg.plannedMinutes + service : 0,
            ...rows.filter((row) => row.status === "subio").map((row) => Number(row.boarded_minutes)),
          ));
          const home = lngLat(route.home_latitude, route.home_longitude);
          try {
            plan = await planRoute({
              transfers: rows.map((row) => ({
                ...toPlanTransfer(row),
                ...(row.status === "subio" ? { boardedMinutes: Number(row.boarded_minutes) } : {}),
              })),
              vehicle: { seats: Number(route.seats), featureIds: (route.feature_ids as number[]).map(Number) },
              start: stopLocation(lastRow, last.kind),
              end: (route.end_kind ?? (neighbours.next ? "open" : "home")) === "home" ? home : null,
              notBeforeMinutes: startMinutes,
              startMinutes,
            }, plannerSettings, solver);
          } catch {
            return context.json({ error: "The routing engine is unavailable: the order was not changed" }, 502);
          }
        } else if (rows.length) {
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
        // A Trasbordo leg is pinned to its Recorrido: the engine never takes it out.
        const pinned = plan.unassigned.filter((item) => rows.some((row) => Number(row.id) === item.transferId && row.trasbordo_stop !== null));
        if (pinned.length) {
          const names = pinned.map((item) => rows.find((row) => Number(row.id) === item.transferId)!.name).join(", ");
          throw new PlanningError(409, `The Trasbordo leg of ${names} does not fit this Recorrido: change the Trasbordo's place or time`);
        }
        const stops = await inTransaction(db, async (client) => {
          await lockOrderInputs(client, id, all, neighbours);
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
          const kept = [...locked, ...voided].map((stop) => ({ ...stop, plannedSeconds: null, legDistanceMeters: null }));
          const order = [...kept, ...plan.stops];
          if (order.length) {
            await client.query(
              `UPDATE stops SET position = o.ord, planned_time = time '00:00' + o.seconds * interval '1 second', leg_distance_meters = o.meters
                 FROM unnest($2::int[], $3::text[], $4::int[], $5::int[]) WITH ORDINALITY AS o(transfer_id, kind, seconds, meters, ord)
                WHERE stops.route_id = $1 AND stops.transfer_id = o.transfer_id AND stops.kind = o.kind`,
              [id, order.map((stop) => stop.transferId), order.map((stop) => stop.kind),
                order.map((stop) => stop.plannedSeconds === null ? null : Math.round(stop.plannedSeconds)), order.map((stop) => stop.legDistanceMeters)],
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
    // Manual order: the full list of the Recorrido's Paradas; a pickup after its own drop-off is refused, and so is moving a
    // done Parada: done Paradas stay first, in their order.
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
            "SELECT s.id, s.transfer_id, s.kind, t.status FROM stops s JOIN transfers t ON t.id = s.transfer_id WHERE s.route_id = $1 ORDER BY s.position",
            [id],
          ) as QueryResult;
          const byId = new Map(current.rows.map((row) => [Number(row.id), row]));
          if (order.length !== byId.size || order.some((stopId) => !byId.has(stopId))) {
            throw new PlanningError(400, "Send every Parada of the Recorrido exactly once");
          }
          const done = (stopId: number) => isDoneStop(String(byId.get(stopId)!.kind), String(byId.get(stopId)!.status));
          const doneNow = current.rows.map((row) => Number(row.id)).filter(done);
          if (order.slice(0, doneNow.length).join() !== doneNow.join()) throw new PlanningError(409, DONE_STOPS_FIRST);
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
        return context.json({ routes: created, ...await warningsAfterCommit(db, created.map((route) => route.id)) }, 201);
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
        const cascade = [...await revalidateChained(actor.id, id), ...await revalidateTrasbordos(actor.id, id)];
        return context.json({ version: result.version, cascade, ...await warningsAfterCommit(db, [id]) }, 201);
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
          } catch (error) {
            if (!(error instanceof PlanningError)) throw error;
            summary.failed.push({ routeId, error: error.message, ...error.extra });
          }
        }
        // Only after every publication, so a chained next Recorrido published later in this call is already there.
        for (const { routeId } of summary.published) {
          summary.cascade.push(...await revalidateChained(actor.id, routeId), ...await revalidateTrasbordos(actor.id, routeId));
        }
        const published = [...summary.published.map((item) => item.routeId), ...summary.unchanged];
        return context.json({ ...summary, ...await warningsAfterCommit(db, published) });
      } catch (error) {
        return planningFailure(context, error);
      }
    })
    // The Choferes who have not acknowledged the latest Versión del plan of their Recorrido; acknowledgedVersion is the last one they saw.
    .get("/daily-plans/:date/acknowledgements", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const date = parsePlanDate(context.req.param("date"));
      if (!date) return context.json({ error: "Invalid request" }, 400);
      try {
        const planId = await findPlanId(db, date);
        const result = await db.query(
          `SELECT * FROM (
             SELECT DISTINCT ON (pv.route_id) pv.id, pv.route_id, pv.version, pv.driver_id, dr.name AS driver_name,
                    to_char(pv.start_time, 'HH24:MI') AS start_time, to_char(pv.end_time, 'HH24:MI') AS end_time,
                    (SELECT max(seen.version) FROM version_acknowledgements va JOIN plan_versions seen ON seen.id = va.plan_version_id
                      WHERE seen.route_id = pv.route_id AND va.driver_id = pv.driver_id) AS acknowledged
               FROM plan_versions pv JOIN routes r ON r.id = pv.route_id JOIN drivers dr ON dr.id = pv.driver_id
              WHERE r.daily_plan_id = $1
              ORDER BY pv.route_id, pv.version DESC) latest
            WHERE NOT EXISTS (SELECT 1 FROM version_acknowledgements va WHERE va.plan_version_id = latest.id AND va.driver_id = latest.driver_id)
            ORDER BY start_time, route_id`,
          [planId],
        ) as QueryResult;
        return context.json({
          missing: result.rows.map((row) => ({
            routeId: Number(row.route_id),
            version: Number(row.version),
            driverId: Number(row.driver_id),
            driverName: String(row.driver_name),
            startTime: String(row.start_time),
            endTime: String(row.end_time),
            acknowledgedVersion: nullableNumber(row.acknowledged),
          })),
        });
      } catch (error) {
        return planningFailure(context, error);
      }
    })
    // The Chofer's own published Recorridos; the server refuses every other day, whatever the app shows.
    .get("/driver/days/:date", async (context) => {
      const chofer = await requireDriver(context);
      if (chofer instanceof Response) return chofer;
      const date = parsePlanDate(context.req.param("date"));
      if (!date) return context.json({ error: "Invalid request" }, 400);
      if (!driverDays(now()).includes(date)) return context.json({ error: OUT_OF_DRIVER_SCOPE }, 403);
      return context.json(await loadDriverDay(db, chofer.driverId, date));
    })
    // A Confirmación de versión records the version the Chofer saw, even when a newer one exists; repeating it is a no-op.
    .post("/driver/routes/:id/acknowledgements", async (context) => {
      const chofer = await requireDriver(context);
      if (chofer instanceof Response) return chofer;
      const id = parseId(context.req.param("id"));
      const body = await context.req.json().catch(() => null);
      const version = isObject(body) ? positiveInt(body.version) : null;
      if (!id || !version) return context.json({ error: "Invalid request" }, 400);
      // A version belongs to the Chofer it was published for, so after a change of Chofer each one acknowledges their own.
      const route = await db.query(
        `SELECT COALESCE(pv.driver_id, r.driver_id) AS driver_id, to_char(dp.plan_date, 'YYYY-MM-DD') AS date
           FROM routes r JOIN daily_plans dp ON dp.id = r.daily_plan_id
           LEFT JOIN plan_versions pv ON pv.route_id = r.id AND pv.version = $2
          WHERE r.id = $1`,
        [id, version],
      ) as QueryResult;
      const row = route.rows[0];
      if (!row) return context.json({ error: "Recorrido not found" }, 404);
      if (Number(row.driver_id) !== chofer.driverId) return context.json({ error: "This Recorrido belongs to another Chofer" }, 403);
      if (!driverDays(now()).includes(String(row.date))) return context.json({ error: OUT_OF_DRIVER_SCOPE }, 403);
      const planVersion = await db.query(
        "SELECT id FROM plan_versions WHERE route_id = $1 AND version = $2",
        [id, version],
      ) as QueryResult;
      if (!planVersion.rows[0]) return context.json({ error: "Versión del plan not found" }, 404);
      const planVersionId = Number(planVersion.rows[0].id);
      const inserted = await db.query(
        `INSERT INTO version_acknowledgements (plan_version_id, driver_id, session_id, acknowledged_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (plan_version_id, driver_id) DO NOTHING RETURNING acknowledged_at`,
        [planVersionId, chofer.driverId, chofer.user.session_id, now()],
      ) as QueryResult;
      const stored = inserted.rows[0] ?? (await db.query(
        "SELECT acknowledged_at FROM version_acknowledgements WHERE plan_version_id = $1 AND driver_id = $2",
        [planVersionId, chofer.driverId],
      ) as QueryResult).rows[0];
      const latest = await db.query("SELECT max(version) AS version FROM plan_versions WHERE route_id = $1", [id]) as QueryResult;
      return context.json({
        acknowledgement: { routeId: id, version, acknowledgedAt: new Date(stored.acknowledged_at as string | Date).toISOString() },
        latestVersion: Number(latest.rows[0].version),
      }, inserted.rows[0] ? 201 : 200);
    })
    // Starting a published Recorrido moves it to En curso; starting it again changes nothing.
    .post("/driver/routes/:id/start", async (context) => {
      const chofer = await requireDriver(context);
      if (chofer instanceof Response) return chofer;
      const id = parseId(context.req.param("id"));
      if (!id) return context.json({ error: "Invalid request" }, 400);
      const route = await ownRoute(context, chofer.driverId, id);
      if (route instanceof Response) return route;
      try {
        await inTransaction(db, async (client) => {
          const status = await lockOwnRoute(client, chofer.driverId, id);
          if (status === "borrador") throw new PlanningError(409, "A Recorrido can be started once it is published");
          if (status === "cerrado") throw new PlanningError(409, "This Recorrido is closed");
          if (status === "publicado") {
            await client.query("UPDATE routes SET status = 'en_curso' WHERE id = $1", [id]);
            await appendChange(client, chofer.user.id, "route", String(id), "started", { status }, { status: "en_curso" });
          }
        });
        return context.json({ route: { routeId: id, status: "en_curso" } });
      } catch (error) {
        return planningFailure(context, error);
      }
    })
    // Closes an En curso Recorrido once no Traslado on it is Planificado or Subió without Entregado; closing it again changes
    // nothing. A refusal lists those Traslados, logs the attempt and raises an alert for the Oficina.
    .post("/driver/routes/:id/close", async (context) => {
      const chofer = await requireDriver(context);
      if (chofer instanceof Response) return chofer;
      const id = parseId(context.req.param("id"));
      if (!id) return context.json({ error: "Invalid request" }, 400);
      const route = await ownRoute(context, chofer.driverId, id);
      if (route instanceof Response) return route;
      try {
        const result = await inTransaction(db, async (client) => {
          // The Traslados are locked before the Recorrido, the order a Marca, a move and an Ausencia use. Locking them again
          // after the Recorrido takes one a move added in between; no move can add another while the Recorrido is locked.
          const lockTransfers = async () => await client.query(
            "SELECT id FROM transfers WHERE id IN (SELECT transfer_id FROM stops WHERE route_id = $1) ORDER BY id FOR UPDATE",
            [id],
          );
          await lockTransfers();
          const status = await lockOwnRoute(client, chofer.driverId, id);
          if (status === "cerrado") return { status: 200 as const, body: { route: { routeId: id, status: "cerrado" } } };
          if (status !== "en_curso") throw new PlanningError(409, "Only a Recorrido en curso can be closed");
          await lockTransfers();
          const open = await client.query(
            `SELECT t.id, t.direction, t.status, p.name FROM transfers t JOIN passengers p ON p.id = t.passenger_id
              WHERE t.id IN (SELECT transfer_id FROM stops WHERE route_id = $1) AND t.status IN ('planificado', 'subio')
              ORDER BY t.target_time, t.id`,
            [id],
          ) as QueryResult;
          if (open.rows.length) {
            const transfers = open.rows.map((row) => ({
              transferId: Number(row.id), passengerName: String(row.name), direction: String(row.direction), status: String(row.status),
            }));
            await insertAlert(client, { kind: "close_refused", routeId: id, details: { transfers } }, now());
            await appendChange(client, chofer.user.id, "route", String(id), "close_refused", { status }, { transfers });
            return {
              status: 409 as const,
              body: { error: "Resolve these Traslados before closing the Recorrido", transfers },
            };
          }
          await client.query("UPDATE routes SET status = 'cerrado' WHERE id = $1", [id]);
          await appendChange(client, chofer.user.id, "route", String(id), "closed", { status }, { status: "cerrado" });
          return { status: 200 as const, body: { route: { routeId: id, status: "cerrado" } } };
        });
        return context.json(result.body, result.status);
      } catch (error) {
        return planningFailure(context, error);
      }
    })
    // A Marca Subió, Ausente or Entregado, idempotent by the phone's UUID; see recordMark.
    .post("/driver/routes/:id/marks", async (context) => {
      const chofer = await requireDriver(context);
      if (chofer instanceof Response) return chofer;
      const id = parseId(context.req.param("id"));
      const fields = parseMark(await context.req.json().catch(() => null));
      if (!id || !fields) return context.json({ error: "Invalid request" }, 400);
      if ("error" in fields) return context.json({ error: fields.error }, 400);
      // A late Marca is still accepted, so the today-and-tomorrow scope does not apply here.
      const route = await ownRoute(context, chofer.driverId, id, true);
      if (route instanceof Response) return route;
      try {
        const { status, ...result } = await inTransaction(db, async (client) => await recordMark(client, chofer, id, fields));
        return context.json(result, status);
      } catch (error) {
        return planningFailure(context, error);
      }
    })
    // A batch of phone Posiciones during Seguimiento of an En curso Recorrido; resending the same phoneTime is ignored.
    .post("/driver/routes/:id/positions", async (context) => {
      const chofer = await requireDriver(context);
      if (chofer instanceof Response) return chofer;
      const id = parseId(context.req.param("id"));
      const current = now();
      const batch = parsePositionBatch(await context.req.json().catch(() => null), current);
      if (!id || !batch) return context.json({ error: "Invalid request" }, 400);
      const route = await ownRoute(context, chofer.driverId, id, true);
      if (route instanceof Response) return route;
      try {
        const result = await inTransaction(db, async (client) => {
          const status = await lockOwnRoute(client, chofer.driverId, id);
          if (status !== "en_curso") throw new PlanningError(409, "Positions can only be recorded while the Recorrido is en curso");
          const inserted = await client.query(
            `INSERT INTO positions (route_id, driver_id, latitude, longitude, accuracy_meters, phone_time, server_time)
             SELECT $1, $2, lat, lng, accuracy_meters, phone_time, $7
               FROM unnest($3::double precision[], $4::double precision[], $5::double precision[], $6::timestamptz[])
                 AS batch(lat, lng, accuracy_meters, phone_time)
             ON CONFLICT (route_id, phone_time) DO NOTHING
             RETURNING id`,
            [
              id,
              chofer.driverId,
              batch.map((item) => item.lat),
              batch.map((item) => item.lng),
              batch.map((item) => item.accuracyMeters),
              batch.map((item) => item.phoneTime),
              current,
            ],
          ) as QueryResult;
          const saved = inserted.rows.length;
          return { saved, ignored: batch.length - saved };
        });
        return context.json(result, result.saved > 0 ? 201 : 200);
      } catch (error) {
        return planningFailure(context, error);
      }
    })
    // What the Chofer needs to hand the Pasajero over at home: the Consentimiento's rule, the Adultos autorizados, the valid
    // Autorizaciones puntuales and the base. "Buscar autorización" calls it again to download a newly recorded one.
    .get("/driver/routes/:id/transfers/:transferId/handover", async (context) => {
      const chofer = await requireDriver(context);
      if (chofer instanceof Response) return chofer;
      const id = parseId(context.req.param("id"));
      const transferId = parseId(context.req.param("transferId"));
      if (!id || !transferId) return context.json({ error: "Invalid request" }, 400);
      const route = await ownRoute(context, chofer.driverId, id);
      if (route instanceof Response) return route;
      const served = await db.query(
        `SELECT t.passenger_id FROM plan_version_transfers pvt JOIN transfers t ON t.id = pvt.transfer_id
          WHERE pvt.transfer_id = $2 AND pvt.plan_version_id = (SELECT id FROM plan_versions WHERE route_id = $1 ORDER BY version DESC LIMIT 1)`,
        [id, transferId],
      ) as QueryResult;
      const passengerId = served.rows[0]?.passenger_id;
      if (passengerId === undefined) return context.json({ error: "Traslado not found in this Recorrido" }, 404);
      const consent = await db.query("SELECT other_adult_allowed FROM consents WHERE passenger_id = $1", [passengerId]) as QueryResult;
      const adults = await db.query(
        "SELECT id, name, relation FROM authorized_adults WHERE passenger_id = $1 AND removed_at IS NULL ORDER BY lower(name), id",
        [passengerId],
      ) as QueryResult;
      const authorizations = await db.query(`${AUTHORIZATION_SELECT_SQL} WHERE oa.transfer_id = $1 ORDER BY oa.id`, [transferId]) as QueryResult;
      return context.json({
        transferId,
        otherAdultAllowed: consent.rows[0]?.other_adult_allowed === true,
        adults: adults.rows.map((row) => ({ id: Number(row.id), name: String(row.name), relation: String(row.relation) })),
        authorizations: authorizations.rows.filter((row) => row.status === "valid")
          .map((row) => ({ id: Number(row.id), name: String(row.name), dni: String(row.dni) })),
        base: config.baseAddress ? { address: config.baseAddress } : null,
      });
    })
    .get("/push/public-key", async (context) => {
      const user = await authenticate(context);
      if (user instanceof Response) return user;
      return context.json({ publicKey: config.vapid?.publicKey ?? null });
    })
    .post("/push/subscriptions", async (context) => {
      const chofer = await requireDriver(context);
      if (chofer instanceof Response) return chofer;
      const body = await context.req.json().catch(() => null);
      if (!isObject(body) || typeof body.endpoint !== "string") {
        return context.json({ error: "Invalid request" }, 400);
      }
      try {
        const url = new URL(body.endpoint);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          return context.json({ error: "Invalid request" }, 400);
        }
      } catch {
        return context.json({ error: "Invalid request" }, 400);
      }
      const keys = isObject(body.keys) ? body.keys : null;
      if (!keys || typeof keys.p256dh !== "string" || !keys.p256dh || typeof keys.auth !== "string" || !keys.auth) {
        return context.json({ error: "Invalid request" }, 400);
      }
      await db.query(
        `INSERT INTO push_subscriptions (session_id, endpoint, p256dh, auth)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (endpoint) DO UPDATE
         SET session_id = EXCLUDED.session_id,
             p256dh = EXCLUDED.p256dh,
             auth = EXCLUDED.auth,
             created_at = now()`,
        [chofer.user.session_id, body.endpoint, keys.p256dh, keys.auth],
      );
      return context.body(null, 204);
    })
    .delete("/push/subscriptions", async (context) => {
      const user = await authenticate(context);
      if (user instanceof Response) return user;
      const body = await context.req.json().catch(() => null);
      const endpoint = isObject(body) && typeof body.endpoint === "string" ? body.endpoint : null;
      if (endpoint) {
        await db.query("DELETE FROM push_subscriptions WHERE session_id = $1 AND endpoint = $2", [user.session_id, endpoint]);
      } else {
        await db.query("DELETE FROM push_subscriptions WHERE session_id = $1", [user.session_id]);
      }
      return context.body(null, 204);
    })
    .get("/transfers/:id/authorizations", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const id = parseId(context.req.param("id"));
      if (!id) return context.json({ error: "Invalid request" }, 400);
      const transfer = await db.query("SELECT id FROM transfers WHERE id = $1", [id]) as QueryResult;
      if (!transfer.rows[0]) return context.json({ error: "Traslado not found" }, 404);
      const result = await db.query(`${AUTHORIZATION_SELECT_SQL} WHERE oa.transfer_id = $1 ORDER BY oa.id`, [id]) as QueryResult;
      return context.json({ authorizations: result.rows.map(formatAuthorization) });
    })
    // Records an Autorización puntual on a salida: only the Responsable legal who signed the Consentimiento gives it, on a call the Oficina makes.
    .post("/transfers/:id/authorizations", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const id = parseId(context.req.param("id"));
      const fields = parseAuthorization(await context.req.json().catch(() => null));
      if (!id || !fields) return context.json({ error: "Invalid request" }, 400);
      if ("error" in fields) return context.json({ error: fields.error }, 400);
      try {
        const authorization = await inTransaction(db, async (client) => {
          const transfer = (await client.query(
            "SELECT passenger_id, direction, status FROM transfers WHERE id = $1 FOR UPDATE",
            [id],
          ) as QueryResult).rows[0];
          if (!transfer) throw new PlanningError(404, "Traslado not found");
          if (transfer.direction !== "salida") {
            throw new PlanningError(409, "An Autorización puntual is for a handover at home, and only a salida ends there");
          }
          if (CLOSED_TRANSFER_STATUSES.includes(String(transfer.status))) {
            throw new PlanningError(409, "The Traslado is closed: an Autorización puntual expires when its Traslado closes");
          }
          // FOR SHARE keeps the Consentimiento from changing signer before this commits.
          const consent = (await client.query(
            "SELECT other_adult_allowed, signed_by_adult_id FROM consents WHERE passenger_id = $1 FOR SHARE",
            [transfer.passenger_id],
          ) as QueryResult).rows[0];
          if (consent?.other_adult_allowed === true) {
            throw new PlanningError(409, "The Consentimiento already allows another adult: no Autorización puntual is needed");
          }
          // The Responsable legal is the Adulto autorizado who signed the Consentimiento, not any adult flagged as a guardian.
          const guardian = (await client.query(
            "SELECT passenger_id, phone FROM authorized_adults WHERE id = $1 AND removed_at IS NULL FOR SHARE",
            [fields.legalGuardianId],
          ) as QueryResult).rows[0];
          if (!guardian || Number(guardian.passenger_id) !== Number(transfer.passenger_id)
            || Number(consent?.signed_by_adult_id) !== fields.legalGuardianId) {
            throw new PlanningError(409, "Only a Responsable legal of this Pasajero can give an Autorización puntual");
          }
          if (fields.call !== "outgoing") {
            throw new PlanningError(409, "Only a call the Oficina makes to the Responsable legal's registered phone counts, not an incoming call");
          }
          const inserted = await client.query(
            `INSERT INTO one_off_authorizations (transfer_id, authorized_by_adult_id, called_phone, name, dni, recorded_by, recorded_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [id, fields.legalGuardianId, guardian.phone, fields.name, fields.dni, actor.id, now()],
          ) as QueryResult;
          const authorizationId = Number(inserted.rows[0].id);
          await appendChange(client, actor.id, "one_off_authorization", String(authorizationId), "recorded", null, {
            transferId: id, legalGuardianId: fields.legalGuardianId, calledPhone: guardian.phone, name: fields.name, dni: fields.dni,
          });
          return formatAuthorization((await client.query(`${AUTHORIZATION_SELECT_SQL} WHERE oa.id = $1`, [authorizationId]) as QueryResult).rows[0]);
        });
        return context.json({ authorization }, 201);
      } catch (error) {
        return planningFailure(context, error);
      }
    })
    // Revokes an unused Autorización puntual. One already used keeps its Entregado and raises a conflict alert instead.
    .post("/authorizations/:id/revocation", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const id = parseId(context.req.param("id"));
      if (!id) return context.json({ error: "Invalid request" }, 400);
      try {
        const result = await inTransaction(db, async (client) => {
          const target = (await client.query("SELECT transfer_id FROM one_off_authorizations WHERE id = $1", [id]) as QueryResult).rows[0];
          if (!target) throw new PlanningError(404, "Autorización puntual not found");
          // The Traslado's lock orders this against a Marca that would use the authorization.
          await client.query("SELECT id FROM transfers WHERE id = $1 FOR UPDATE", [target.transfer_id]);
          const load = async () => formatAuthorization((await client.query(`${AUTHORIZATION_SELECT_SQL} WHERE oa.id = $1`, [id]) as QueryResult).rows[0]);
          const current = await load();
          if (current.status === "revoked") return { status: 200 as const, body: { authorization: current } };
          if (current.status === "expired") throw new PlanningError(409, "The Autorización puntual expired when its Traslado closed");
          if (current.status === "used") {
            const use = (await client.query(
              `SELECT e.id, pv.route_id FROM marks e JOIN plan_versions pv ON pv.id = e.plan_version_id
                 JOIN one_off_authorizations oa ON oa.id = $1 WHERE ${AUTHORIZATION_USE_SQL} ORDER BY e.id LIMIT 1`,
              [id],
            ) as QueryResult).rows[0];
            await insertAlert(client, {
              kind: "authorization_conflict", transferId: current.transferId, routeId: Number(use.route_id), markId: Number(use.id),
              // One alert per Entregado: once that one is undone, another Entregado in force can use the authorization again.
              details: { authorizationId: id, name: current.name }, dedupeKey: `authorization_conflict:${id}:${Number(use.id)}`,
            }, now());
            return {
              status: 409 as const,
              body: { error: "The Autorización puntual was already used: the Entregado stands and the conflict is in the alert inbox" },
            };
          }
          await client.query(
            "INSERT INTO one_off_authorization_revocations (authorization_id, revoked_by, revoked_at) VALUES ($1, $2, $3)",
            [id, actor.id, now()],
          );
          await appendChange(client, actor.id, "one_off_authorization", String(id), "revoked", { status: current.status }, { status: "revoked" });
          return { status: 201 as const, body: { authorization: await load() } };
        });
        return context.json(result.body, result.status);
      } catch (error) {
        return planningFailure(context, error);
      }
    })
    // The Oficina corrects a Traslado's latest Marca at any time, always with a reason; see recordMark. The Corrección
    // gets a new UUID, the server time and the original's Versión del plan.
    .post("/marks/:id/corrections", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const target = context.req.param("id");
      const body = await context.req.json().catch(() => null);
      if (!UUID_PATTERN.test(target) || !isObject(body)) return context.json({ error: "Invalid request" }, 400);
      const reason = boundedText(body.reason, 1000);
      if (!reason) return context.json({ error: REASON_REQUIRED }, 400);
      const original = (await db.query(`${MARK_SELECT_SQL} WHERE m.client_id = $1`, [target.toLowerCase()]) as QueryResult).rows[0];
      if (!original) return context.json({ error: "Marca not found" }, 404);
      const fields = parseMark({
        kind: body.kind, receiver: body.receiver, id: randomUUID(), transferId: original.transfer_id, version: original.version,
        phoneTime: now().toISOString(), location: null, corrects: target,
      });
      if (!fields) return context.json({ error: "Invalid request" }, 400);
      if ("error" in fields) return context.json({ error: fields.error }, 400);
      try {
        const { status, ...result } = await inTransaction(db, async (client) => await recordMark(
          client, { user: actor, driverId: null }, Number(original.route_id), fields, reason,
        ));
        return context.json(result, status);
      } catch (error) {
        return planningFailure(context, error);
      }
    })
    // Everything that happened to a Traslado: its planned times in each Versión del plan, every Marca and Corrección with
    // who made it, and the Oficina's changes, each with its actor; with the Marcas of every leg of its Trasbordo chain.
    .get("/transfers/:id/history", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const id = parseId(context.req.param("id"));
      if (!id) return context.json({ error: "Invalid request" }, 400);
      const transfer = (await db.query("SELECT status FROM transfers WHERE id = $1", [id]) as QueryResult).rows[0];
      if (!transfer) return context.json({ error: "Traslado not found" }, 404);
      const versions = await db.query(
        `SELECT pv.route_id, pv.version, pv.published_at, u.username, dr.name AS driver_name,
                (SELECT to_char(l.planned_time, 'HH24:MI') FROM plan_version_legs l
                  WHERE l.plan_version_id = pv.id AND l.transfer_id = $1 AND l.kind = 'pickup') AS pickup,
                (SELECT to_char(l.planned_time, 'HH24:MI') FROM plan_version_legs l
                  WHERE l.plan_version_id = pv.id AND l.transfer_id = $1 AND l.kind = 'dropoff') AS dropoff
           FROM plan_version_transfers pvt JOIN plan_versions pv ON pv.id = pvt.plan_version_id
           JOIN users u ON u.id = pv.published_by JOIN drivers dr ON dr.id = pv.driver_id
          WHERE pvt.transfer_id = $1 ORDER BY pv.published_at, pv.id`,
        [id],
      ) as QueryResult;
      // The legs of its Trasbordo chain, first to last: back to the first leg, then forward through the legs chained to it.
      const chain = (await db.query(
        `WITH RECURSIVE back(id, previous) AS (
           SELECT id, chained_from_transfer_id FROM transfers WHERE id = $1
           UNION ALL SELECT t.id, t.chained_from_transfer_id FROM transfers t JOIN back ON t.id = back.previous),
         forward(id, n) AS (
           SELECT id, 1 FROM back WHERE previous IS NULL
           UNION ALL SELECT t.id, forward.n + 1 FROM transfers t JOIN forward ON t.chained_from_transfer_id = forward.id)
         SELECT id FROM forward ORDER BY n`,
        [id],
      ) as QueryResult).rows.map((row) => Number(row.id));
      const chainMarks = await db.query(
        `SELECT h.*, ra.name AS receiver_adult_name, ra.relation AS receiver_relation, rd.name AS receiver_destination_name
           FROM (${MARK_SELECT_SQL} WHERE m.transfer_id = ANY($1::int[])) h
           LEFT JOIN authorized_adults ra ON ra.id = h.receiver_adult_id LEFT JOIN destinations rd ON rd.id = h.receiver_destination_id
          ORDER BY h.id`,
        [chain],
      ) as QueryResult;
      const historyMarks = (transferId: number) => chainMarks.rows.filter((row) => Number(row.transfer_id) === transferId).map((row) => {
        const mark = formatMark(row);
        return {
          ...mark,
          receiver: historyReceiver(mark.receiver, row),
          author: { userId: Number(row.author_user_id), username: String(row.author_username), role: String(row.author_role) },
        };
      });
      const changes = await db.query(
        `SELECT cl.action, cl.before_data, cl.after_data, cl.occurred_at, cl.actor_user_id, cl.actor_label, u.username
           FROM change_log cl LEFT JOIN users u ON u.id = cl.actor_user_id
          WHERE cl.entity = 'transfer' AND cl.entity_id = $1 ORDER BY cl.occurred_at, cl.id`,
        [String(id)],
      ) as QueryResult;
      return context.json({
        transferId: id,
        status: String(transfer.status),
        versions: versions.rows.map((row) => ({
          routeId: Number(row.route_id),
          version: Number(row.version),
          publishedAt: new Date(row.published_at as string | Date).toISOString(),
          publishedBy: String(row.username),
          driverName: String(row.driver_name),
          pickupTime: (row.pickup as string | null) ?? null,
          dropoffTime: (row.dropoff as string | null) ?? null,
        })),
        marks: historyMarks(id),
        // A leg of a Trasbordo: every leg of the chain, first to last, with its Marcas.
        ...(chain.length > 1 ? { chain: chain.map((transferId) => ({ transferId, marks: historyMarks(transferId) })) } : {}),
        changes: changes.rows.map((row) => ({
          action: String(row.action),
          before: row.before_data,
          after: row.after_data,
          occurredAt: new Date(row.occurred_at as string | Date).toISOString(),
          actor: { userId: nullableNumber(row.actor_user_id), name: (row.username ?? row.actor_label ?? null) as string | null },
        })),
      });
    })
    // The Oficina's alert inbox, newest first; the office app polls it. An Ausente on an entrada, a flagged Marca and a
    // handover to another adult are resolved while a Corrección replaces their Marca: undoing that Corrección puts the Marca
    // back in force and its alert back to pending.
    .get("/alerts", async (context) => {
      const actor = await requireOffice(context);
      if (actor instanceof Response) return actor;
      const result = await db.query(
        `SELECT al.id, al.kind, al.created_at, al.transfer_id, al.route_id, m.client_id AS mark_id, p.name AS passenger_name,
                dr.name AS driver_name, al.details, rc.client_id AS resolved_by_mark_id, rc.kind AS resolved_by_kind,
                rc.server_time AS resolved_at, rc.reason AS resolved_reason, rc.user_id AS resolved_user_id,
                rc.username AS resolved_username, rc.role AS resolved_role
           FROM alerts al
           LEFT JOIN marks m ON m.id = al.mark_id
           LEFT JOIN transfers t ON t.id = al.transfer_id LEFT JOIN passengers p ON p.id = t.passenger_id
           LEFT JOIN routes r ON r.id = al.route_id LEFT JOIN drivers dr ON dr.id = r.driver_id
           LEFT JOIN LATERAL (
             SELECT c.client_id, c.kind, c.server_time, c.reason, ru.id AS user_id, ru.username, ru.role
               FROM marks c JOIN sessions rs ON rs.id = c.session_id JOIN users ru ON ru.id = rs.user_id
              WHERE al.kind = ANY('{absent_on_entrada,mark_flagged,other_adult_handover}'::text[])
                AND c.corrects_mark_id = al.mark_id AND ${REPLACES_SQL}
              ORDER BY c.id DESC LIMIT 1
           ) rc ON true
          ORDER BY al.id DESC LIMIT 200`,
      ) as QueryResult;
      return context.json({
        alerts: result.rows.map((row) => ({
          id: Number(row.id),
          kind: String(row.kind),
          createdAt: new Date(String(row.created_at)).toISOString(),
          transferId: nullableNumber(row.transfer_id),
          routeId: nullableNumber(row.route_id),
          markId: (row.mark_id as string | null) ?? null,
          passengerName: (row.passenger_name as string | null) ?? null,
          driverName: (row.driver_name as string | null) ?? null,
          details: row.details as Record<string, unknown>,
          resolution: row.resolved_by_mark_id ? {
            markId: String(row.resolved_by_mark_id),
            kind: String(row.resolved_by_kind),
            at: new Date(String(row.resolved_at)).toISOString(),
            reason: (row.resolved_reason as string | null) ?? null,
            author: { userId: Number(row.resolved_user_id), username: String(row.resolved_username), role: String(row.resolved_role) },
          } : null,
        })),
      });
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
