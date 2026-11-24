/**
 * Demo seed (issue #141, ADR 0003): loads the synthetic demo data and publishes the Plan diario of one date by calling
 * the API's public HTTP routes as the synthetic Oficina account, exactly as the office app would. It never touches the
 * database directly, so every validation, the routing engine, the route validator and the publication run.
 *
 * Run by `deploy/seed-demo.sh`; it only uses Node built-ins so plain `node` can run this file with type stripping.
 */
import { createHmac, randomBytes } from "node:crypto";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type SeedFetch = (url: string, init: RequestInit) => Promise<Response>;

export type DemoSeedOptions = {
  project: string;
  stateDir: string;
  date: string;
  fetch?: SeedFetch;
  now?: () => Date;
  log?: (line: string) => void;
};

/** A failure the operator can act on; the command prints its message and exits with an error. */
export class DemoSeedError extends Error {}

export const OFFICE_USERNAME = "demo-oficina";
const TIME_ZONE = "America/Argentina/Tucuman";
const TOTP_PERIOD_MS = 30_000;
const REQUEST_TIMEOUT_MS = 120_000;
// The only projects the seed may run against, with the command that starts each one.
const START_HINTS: Record<string, string> = {
  staging: "levantá el staging con local-staging.sh up",
  "prueba-de-campo": "levantá la Prueba de campo con prueba-de-campo.sh up",
};

type Place = { address: string; lat: number; lng: number };

// Synthetic records only. Real places of San Miguel de Tucumán are used as geographic points, never as anyone's home.
const DESTINATIONS = [
  { name: "Escuela Demo", kind: "school", address: "Plaza Urquiza, San Miguel de Tucumán", lat: -26.8207, lng: -65.1993 },
  { name: "Centro de día Demo", kind: "day_centre", address: "Plaza Belgrano, San Miguel de Tucumán", lat: -26.8369, lng: -65.2124 },
  { name: "Centro de terapia Demo", kind: "therapy", address: "Plaza Alberdi, San Miguel de Tucumán", lat: -26.8188, lng: -65.2108 },
  { name: "Consultorio Demo", kind: "clinic", address: "Plaza Independencia, San Miguel de Tucumán", lat: -26.8303, lng: -65.2038 },
];

const VEHICLES = [1, 2, 3].map((n) => ({ plate: `DEMO00${n}`, model: "Furgón Demo", seats: 8 }));

const DRIVER_HOMES: Place[] = [
  { address: "Parque 9 de Julio, San Miguel de Tucumán", lat: -26.8295, lng: -65.1905 },
  { address: "Terminal de Ómnibus, San Miguel de Tucumán", lat: -26.8338, lng: -65.1975 },
  { address: "Parque Avellaneda, San Miguel de Tucumán", lat: -26.8158, lng: -65.2185 },
];

const DRIVERS = DRIVER_HOMES.map((home, index) => ({
  username: `chofer-demo-${index + 1}`,
  name: `Chofer Demo ${index + 1}`,
  home,
}));

const PASSENGER_HOMES: Place[] = [
  { address: "Casa Histórica de la Independencia, San Miguel de Tucumán", lat: -26.8336, lng: -65.2033 },
  { address: "Teatro San Martín, San Miguel de Tucumán", lat: -26.8282, lng: -65.2085 },
  { address: "Mercado del Norte, San Miguel de Tucumán", lat: -26.8262, lng: -65.2042 },
  { address: "Plaza San Martín, San Miguel de Tucumán", lat: -26.8236, lng: -65.2140 },
  { address: "Plaza Yrigoyen, San Miguel de Tucumán", lat: -26.8401, lng: -65.2072 },
  { address: "Esquina de avenida Roca y avenida Mitre, San Miguel de Tucumán", lat: -26.8420, lng: -65.2160 },
  { address: "Esquina de avenida Sarmiento y avenida Mitre, San Miguel de Tucumán", lat: -26.8253, lng: -65.2178 },
  { address: "Esquina de avenida Belgrano y avenida Mitre, San Miguel de Tucumán", lat: -26.8330, lng: -65.2190 },
  { address: "Esquina de avenida Mate de Luna y avenida Mitre, San Miguel de Tucumán", lat: -26.8297, lng: -65.2182 },
  { address: "Esquina de avenida Alem y avenida Kirchner, San Miguel de Tucumán", lat: -26.8455, lng: -65.2215 },
  { address: "Esquina de avenida Avellaneda y avenida Sarmiento, San Miguel de Tucumán", lat: -26.8225, lng: -65.2000 },
  { address: "Esquina de avenida Brígido Terán y avenida Benjamín Aráoz, San Miguel de Tucumán", lat: -26.8265, lng: -65.1955 },
];

// Needs are neutral requirements (here the Asiento delantero), never a reason: no sex, gender or diagnosis.
const PASSENGERS = PASSENGER_HOMES.map((home, index) => {
  const number = String(index + 1).padStart(2, "0");
  return {
    name: `Pasajero Demo ${number}`,
    home,
    frontSeat: index % 4 === 0,
    // A DNI and a phone that cannot belong to anyone, on purpose.
    adult: { name: `Adulto Demo ${number}`, dni: `DEMO-${number}`, relation: "responsable", phone: `000-000-00${number}` },
  };
});

// Morning entradas: Recorrido N takes Pasajeros 4N-3..4N to Destino N.
const ROUTES = DRIVERS.map((_, index) => ({
  driver: index,
  destination: index,
  passengers: [0, 1, 2, 3].map((offset) => index * 4 + offset),
  startTime: "07:00",
  endTime: "09:30",
  targetTime: "08:30",
}));

type Json = Record<string, unknown>;

export async function runDemoSeed(options: DemoSeedOptions) {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((line: string) => console.log(line));
  const fetchFn = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }));
  const startHint = START_HINTS[options.project];
  if (!startHint) throw new DemoSeedError(`El seed de demo solo corre con DEPLOY_PROJECT=staging o DEPLOY_PROJECT=prueba-de-campo, no con "${options.project}"`);
  checkDate(options.date, now());
  const state = options.stateDir;
  await checkStateProject(state, options.project, startHint);
  const office = await officeUrl(state, startHint);
  const api = createClient(`${office}/api`, office, fetchFn);
  if (!await api.healthy()) throw new DemoSeedError(startHint);

  await signIn(api, state, now, log);
  const masters = await ensureMasters(api, state);
  const published = await ensurePlan(api, options.date, masters, log);
  if (published) log(`Plan diario ${options.date} publicado: ${ROUTES.length} Recorridos, ${ROUTES.length * 4} Traslados.`);
  log("Credenciales:");
  log(`  Oficina: ${OFFICE_USERNAME} (contraseña en ${join(state, "office-password")}, TOTP en ${join(state, "office-totp-secret")})`);
  log(`  Choferes: ${DRIVERS.map((driver) => driver.username).join(", ")} (contraseñas en ${join(state, "demo-driver-passwords")})`);
}

function checkDate(date: string, now: Date) {
  const invalid = new DemoSeedError(`Fecha inválida "${date}": usá AAAA-MM-DD`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw invalid;
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) throw invalid;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  if (date < today) throw new DemoSeedError(`La fecha ${date} ya pasó: elegí hoy (${today}) o una fecha futura`);
}

async function readOptional(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Writes an operator-only file atomically, so a crash never leaves a half-written secret. */
async function writePrivate(path: string, content: string) {
  const temporary = `${path}.tmp`;
  await rm(temporary, { force: true });
  await writeFile(temporary, content, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

/** The environment's own env file must exist and name this project; anything else fails closed. */
async function checkStateProject(state: string, project: string, startHint: string) {
  const env = await readOptional(join(state, ".env"));
  if (env === null) throw new DemoSeedError(startHint);
  const declared = env.split(/\r?\n/).filter((line) => line.startsWith("DEPLOY_PROJECT=")).map((line) => line.slice("DEPLOY_PROJECT=".length));
  if (declared.length !== 1 || declared[0] !== project) {
    throw new DemoSeedError(`${join(state, ".env")} no es del proyecto ${project}: no siembro nada`);
  }
}

async function officeUrl(state: string, startHint: string) {
  const urls = await readOptional(join(state, "urls"));
  const line = urls?.split(/\r?\n/).find((item) => item.startsWith("office: "));
  if (!line) throw new DemoSeedError(startHint);
  try {
    const url = new URL(line.slice("office: ".length).trim());
    if (url.protocol !== "https:") throw new Error("not https");
    return url.origin;
  } catch {
    throw new DemoSeedError(`${join(state, "urls")} no tiene una URL de Oficina válida: ${startHint}`);
  }
}

type Client = ReturnType<typeof createClient>;

/** HTTP client of the Oficina: same-site JSON calls with the office Origin, carrying the session cookie. */
function createClient(base: string, origin: string, fetchFn: SeedFetch) {
  let cookie = "";
  async function send(method: string, path: string, body?: unknown) {
    const response = await fetchFn(`${base}${path}`, {
      method,
      headers: {
        Origin: origin,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const token = response.headers.get("set-cookie")?.match(/(?:^|, )session=([^;]*)/)?.[1];
    if (token !== undefined) cookie = token ? `session=${token}` : "";
    const text = await response.text();
    let data: Json = {};
    try {
      data = text ? JSON.parse(text) as Json : {};
    } catch {
      data = { error: text };
    }
    return { status: response.status, data };
  }
  return {
    send,
    /** Sends the call and returns its JSON body, or fails with the API's own error (and violations, when it sends them). */
    async call(method: string, path: string, body?: unknown) {
      const { status, data } = await send(method, path, body);
      if (status >= 200 && status < 300) return data;
      throw new DemoSeedError(apiError(`${method} ${path}`, status, data));
    },
    async healthy() {
      try {
        return (await fetchFn(`${base}/health`, { method: "GET", headers: { Origin: origin } })).ok;
      } catch {
        return false;
      }
    },
  };
}

function apiError(call: string, status: number, data: Json) {
  const violations = data.violations === undefined ? "" : ` ${JSON.stringify(data.violations)}`;
  return `${call} respondió ${status}: ${String(data.error ?? "sin detalle")}${violations}`;
}

async function signIn(api: Client, state: string, now: () => Date, log: (line: string) => void) {
  const password = (await readOptional(join(state, "office-password")))?.trim();
  if (!password) throw new DemoSeedError(`Falta ${join(state, "office-password")}: levantá el entorno para crear la cuenta de Oficina`);
  const login = await api.send("POST", "/auth/login", { username: OFFICE_USERNAME, password, deviceLabel: "Seed de demo" });
  if (login.status !== 200) throw new DemoSeedError(apiError(`Login de ${OFFICE_USERNAME}`, login.status, login.data));
  const secretFile = join(state, "office-totp-secret");
  if (login.data.secondFactor === "enrolment_required") {
    const enrolment = await api.call("POST", "/auth/totp/enrol");
    const secret = String(enrolment.secret);
    await writePrivate(secretFile, `${secret}\n`);
    log(`Segundo factor de ${OFFICE_USERNAME} enrolado; el secreto está en ${secretFile}.`);
    log(`Cargá esta URI en una app de autenticación gratuita (por ejemplo, como código QR): ${String(enrolment.uri)}`);
    await verifyTotp(api, decodeBase32(secret), now);
  } else if (login.data.secondFactor === "code_required") {
    const secret = (await readOptional(secretFile))?.trim();
    if (!secret) {
      throw new DemoSeedError(
        `${OFFICE_USERNAME} ya tiene el TOTP enrolado pero falta ${secretFile}: recuperá la cuenta con db:break-glass-office y volvé a correr el seed`,
      );
    }
    await verifyTotp(api, decodeBase32(secret), now);
  }
}

/** The API accepts each 30-second step once: a rerun inside the same step uses the next one, inside its ±1 window. */
async function verifyTotp(api: Client, key: Buffer, now: () => Date) {
  const step = Math.floor(now().getTime() / TOTP_PERIOD_MS);
  for (const candidate of [step, step + 1]) {
    const result = await api.send("POST", "/auth/totp/verify", { code: totpCode(key, candidate) });
    if (result.status === 204) return;
    if (result.status !== 400) throw new DemoSeedError(apiError("POST /auth/totp/verify", result.status, result.data));
  }
  throw new DemoSeedError("La API rechazó el código TOTP: esperá 30 segundos y volvé a correr el seed");
}

/** RFC 6238 TOTP code (HMAC-SHA1, 6 digits) for one 30-second step, as the API and authenticator apps compute it. */
export function totpCode(key: Buffer, step: number) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

function decodeBase32(text: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of text.toUpperCase().replace(/=+$/, "")) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new DemoSeedError("office-totp-secret no es un secreto TOTP válido");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(bytes);
}

type Masters = { destinations: number[]; vehicles: number[]; drivers: number[]; passengers: number[] };

function rows(data: Json, key: string) {
  return (data[key] ?? []) as Json[];
}

/** Returns the id of `found`, or creates the record and returns the id the API gave it under `key`. */
async function idOf(found: Json | undefined, create: () => Promise<Json>, key: string) {
  if (found) return Number(found.id);
  return Number(((await create())[key] as Json).id);
}

/** Finds each synthetic master by name before creating it, so reruns and other dates reuse the same records. */
async function ensureMasters(api: Client, state: string): Promise<Masters> {
  const existingDestinations = rows(await api.call("GET", "/destinations"), "destinations");
  const destinations: number[] = [];
  for (const destination of DESTINATIONS) {
    const found = existingDestinations.find((row) => row.name === destination.name);
    destinations.push(await idOf(found, () => api.call("POST", "/destinations", destination), "destination"));
  }

  const existingVehicles = rows(await api.call("GET", "/vehicles"), "vehicles");
  const vehicles: number[] = [];
  for (const vehicle of VEHICLES) {
    const found = existingVehicles.find((row) => row.plate === vehicle.plate);
    vehicles.push(await idOf(found, () => api.call("POST", "/vehicles", vehicle), "vehicle"));
  }

  const userIds = await ensureDriverUsers(api, state);
  const existingDrivers = rows(await api.call("GET", "/drivers"), "drivers");
  const drivers: number[] = [];
  for (const [index, driver] of DRIVERS.entries()) {
    const found = existingDrivers.find((row) => Number(row.userId) === userIds[index]);
    drivers.push(await idOf(found, () => api.call("POST", "/drivers", {
      userId: userIds[index],
      name: driver.name,
      homeAddress: driver.home.address,
      homeLat: driver.home.lat,
      homeLng: driver.home.lng,
      usualVehicleId: vehicles[index],
    }), "driver"));
  }

  const existingPassengers = rows(await api.call("GET", "/passengers"), "passengers");
  const passengers: number[] = [];
  for (const passenger of PASSENGERS) {
    const found = existingPassengers.find((row) => row.name === passenger.name);
    const id = await idOf(found, () => api.call("POST", "/passengers", {
      name: passenger.name,
      homeAddress: passenger.home.address,
      homeLat: passenger.home.lat,
      homeLng: passenger.home.lng,
      companions: 0,
      frontSeat: passenger.frontSeat,
      wheelchair: false,
      maxRideTimeMinutes: 60,
      pickupDurationMinutes: 3,
      dropoffDurationMinutes: 3,
    }), "passenger");
    const adults = rows(await api.call("GET", `/passengers/${id}/authorized-adults`), "adults");
    const adultId = await idOf(
      adults.find((row) => row.name === passenger.adult.name),
      () => api.call("POST", `/passengers/${id}/authorized-adults`, { ...passenger.adult, legalGuardian: true }),
      "adult",
    );
    // Recording the same Consentimiento again changes nothing in the API.
    await api.call("POST", `/passengers/${id}/consent`, { signedByAdultId: adultId, signedAt: "2026-11-01", otherAdultAllowed: false });
    passengers.push(id);
  }
  return { destinations, vehicles, drivers, passengers };
}

/**
 * Driver accounts with generated passwords. Passwords are saved before any account is created, so a crash never leaves
 * an account whose password nobody has; an existing account whose password is not in the file gets a new one.
 */
async function ensureDriverUsers(api: Client, state: string) {
  const file = join(state, "demo-driver-passwords");
  const known = new Map<string, string>();
  for (const line of ((await readOptional(file)) ?? "").split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator > 0 && line.slice(separator + 1)) known.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const passwords = new Map(known);
  for (const driver of DRIVERS) if (!passwords.has(driver.username)) passwords.set(driver.username, randomBytes(12).toString("hex"));
  if (passwords.size !== known.size) {
    await writePrivate(file, [...passwords].map(([username, password]) => `${username}:${password}\n`).join(""));
  }
  const users = rows(await api.call("GET", "/users"), "users");
  const ids: number[] = [];
  for (const driver of DRIVERS) {
    const password = passwords.get(driver.username)!;
    const found = users.find((row) => row.username === driver.username);
    if (found && found.role !== "driver") throw new DemoSeedError(`El usuario ${driver.username} existe pero no es de Chofer: no lo toco`);
    if (found && !known.has(driver.username)) await api.call("PATCH", `/users/${Number(found.id)}/password`, { password });
    ids.push(await idOf(found, () => api.call("POST", "/users", { username: driver.username, password, role: "driver" }), "user"));
  }
  return ids;
}

/**
 * Creates the Plan diario of `date` with its Traslados and Recorridos, orders each Recorrido with the routing engine and
 * publishes it without forcing. Leaves a day that already has a published Recorrido untouched; returns whether it published.
 */
async function ensurePlan(api: Client, date: string, masters: Masters, log: (line: string) => void) {
  const plan = await api.call("POST", "/daily-plans", { date });
  const routes = rows(plan, "routes");
  const published = (route: Json | undefined) => route?.version !== null && route?.version !== undefined;
  if (routes.some(published)) {
    // Left untouched either way; a day published only in part (a rejection or a crash between publications) is an error.
    const missing = ROUTES
      .filter((spec) => !published(routes.find((route) => Number(route.driverId) === masters.drivers[spec.driver])))
      .map((spec) => `el Recorrido de ${DRIVERS[spec.driver].name}`);
    const unpublished = plan.unpublishedTransferIds;
    if (!Array.isArray(unpublished) || unpublished.length) missing.push("Traslados sin publicar");
    if (missing.length) {
      throw new DemoSeedError(`El Plan diario ${date} quedó publicado a medias (falta: ${missing.join(", ")}): no lo toco; terminá de publicarlo desde la Oficina`);
    }
    log(`El Plan diario ${date} ya tiene Recorridos publicados: no lo toco.`);
    return false;
  }
  const transfers = rows(plan, "transfers");
  const routeIds: number[] = [];
  for (const spec of ROUTES) {
    const driverId = masters.drivers[spec.driver];
    const destinationId = masters.destinations[spec.destination];
    const routeId = await idOf(
      routes.find((route) => Number(route.driverId) === driverId),
      () => api.call("POST", `/daily-plans/${date}/routes`, { driverId, startTime: spec.startTime, endTime: spec.endTime }),
      "route",
    );
    for (const index of spec.passengers) {
      const passengerId = masters.passengers[index];
      const found = transfers.find((transfer) =>
        Number(transfer.passengerId) === passengerId && transfer.direction === "entrada" && Number(transfer.destinationId) === destinationId);
      const transferId = await idOf(found, () => api.call("POST", `/daily-plans/${date}/transfers`, {
        passengerId, destinationId, direction: "entrada", targetTime: spec.targetTime,
      }), "transfer");
      if (found?.routeId !== routeId) await api.call("PATCH", `/transfers/${transferId}`, { routeId });
    }
    routeIds.push(routeId);
  }
  // Every Recorrido is ordered before any is published, so an engine failure leaves the whole day unpublished.
  for (const [index, routeId] of routeIds.entries()) {
    const ordered = await api.call("POST", `/routes/${routeId}/order`);
    const unassigned = rows(ordered, "unassigned");
    if (unassigned.length) {
      const names = unassigned.map((item) => `${String(item.passengerName)} (${String(item.reason)})`).join(", ");
      throw new DemoSeedError(`El motor de rutas dejó sin Recorrido, en el de ${DRIVERS[ROUTES[index].driver].name}: ${names}`);
    }
  }
  // Never a Publicación forzada: no overrideReason, so the validator's verdict stands.
  for (const routeId of routeIds) await api.call("POST", `/routes/${routeId}/publish`, {});
  return true;
}

async function main(argv: string[]) {
  if (argv.length !== 3) {
    console.error("Uso: node demo-seed.ts <proyecto> <directorio-de-estado> <AAAA-MM-DD>");
    process.exitCode = 2;
    return;
  }
  const [project, stateDir, date] = argv;
  try {
    await runDemoSeed({ project, stateDir: resolve(stateDir), date });
  } catch (error) {
    console.error(error instanceof DemoSeedError ? error.message : error);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
