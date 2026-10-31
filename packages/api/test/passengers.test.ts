import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateRoute } from "@traslado/shared";
import { createApp, type RoutingHealth } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { createPool } from "../src/db.js";
import { getSessionCookie, signInOffice } from "./helpers/office-session.js";

const appPool = createPool(process.env.TEST_DATABASE_URL!);
const migrationPool = createPool(process.env.TEST_MIGRATION_DATABASE_URL!);
const routingUp: RoutingHealth = { osrm: async () => undefined, vroom: async () => undefined };
const app = createApp({ db: appPool, routing: routingUp, config: { serverEpoch: "passengers-test" } });

// Synthetic data only.
const validPassenger = {
  name: "Pasajero Sintético Uno",
  homeAddress: "Calle Inventada 202",
  homeLat: -26.8302,
  homeLng: -65.2101,
  accessNotes: "Portón verde, tocar timbre",
  companions: 1,
  frontSeat: false,
  wheelchair: true,
  featureIds: [] as number[],
  maxRideTimeMinutes: 60,
  pickupDurationMinutes: 5,
  dropoffDurationMinutes: 5,
  medicalAlert: "Alerta sintética: llevar inhalador",
};

const PASSENGER_KEYS = [
  "accessNotes", "companions", "createdAt", "deactivatedAt", "dropoffDurationMinutes", "featureIds", "features", "frontSeat",
  "homeAddress", "homeLat", "homeLng", "id", "maxRideTimeMinutes", "medicalAlert", "name", "pickupDurationMinutes", "wheelchair",
];

async function request(path: string, method: string, body?: unknown, cookie?: string) {
  return await app.request(path, {
    method,
    headers: {
      Origin: "http://localhost",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function seedUser(username: string, role: "office" | "driver") {
  await migrationPool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)",
    [username, await hashPassword(`${username}-password`), role],
  );
}

async function signIn(username: string, role: "office" | "driver") {
  await seedUser(username, role);
  if (role === "office") return (await signInOffice(app, migrationPool, username, `${username}-password`)).cookie;
  const response = await request("/auth/login", "POST", { username, password: `${username}-password`, deviceLabel: "Test browser" });
  return getSessionCookie(response).cookie;
}

async function createPassenger(office: string, overrides: Record<string, unknown> = {}) {
  const response = await request("/passengers", "POST", { ...validPassenger, ...overrides }, office);
  expect(response.status).toBe(201);
  return (await response.json()).passenger;
}

async function createFeature(office: string, name: string) {
  const response = await request("/vehicle-features", "POST", { name }, office);
  return (await response.json()).feature.id as number;
}

async function storedPassengers() {
  return (await migrationPool.query("SELECT * FROM passengers ORDER BY id")).rows;
}

async function passengerLog() {
  return (await migrationPool.query(
    "SELECT entity_id, action, before_data, after_data FROM change_log WHERE entity = 'passenger' ORDER BY id",
  )).rows;
}

beforeAll(async () => {
  await appPool.query("SELECT 1");
});

afterAll(async () => {
  await Promise.all([appPool.end(), migrationPool.end()]);
});

describe("Pasajeros", () => {
  it("lets only the Oficina create, list, edit, deactivate and reactivate Pasajeros and logs each write in the same transaction", async () => {
    const driver = await signIn("chofer-pasajeros", "driver");
    const office = await signIn("oficina-pasajeros", "office");
    const ramp = await createFeature(office, "rampa para silla de ruedas");

    for (const [method, path, body] of [
      ["GET", "/passengers", undefined],
      ["POST", "/passengers", validPassenger],
      ["PATCH", "/passengers/1", validPassenger],
      ["PATCH", "/passengers/1/deactivate", {}],
      ["PATCH", "/passengers/1/reactivate", {}],
    ] as const) {
      expect((await request(path, method, body)).status, `${method} ${path} without session`).toBe(401);
      expect((await request(path, method, body, driver)).status, `${method} ${path} as Chofer`).toBe(403);
    }
    expect(await storedPassengers()).toEqual([]);

    const created = await createPassenger(office, { name: "  Pasajero Sintético Uno  ", featureIds: [ramp] });
    expect(created).toEqual({
      id: expect.any(Number),
      name: "Pasajero Sintético Uno",
      homeAddress: "Calle Inventada 202",
      homeLat: -26.8302,
      homeLng: -65.2101,
      accessNotes: "Portón verde, tocar timbre",
      companions: 1,
      frontSeat: false,
      wheelchair: true,
      featureIds: [ramp],
      features: ["rampa para silla de ruedas"],
      maxRideTimeMinutes: 60,
      pickupDurationMinutes: 5,
      dropoffDurationMinutes: 5,
      medicalAlert: "Alerta sintética: llevar inhalador",
      deactivatedAt: null,
      createdAt: expect.any(String),
    });

    const edit = {
      ...validPassenger,
      name: "Pasajero Sintético Editado",
      homeAddress: "Pasaje Ficticio 303",
      homeLat: -26.81,
      homeLng: -65.22,
      accessNotes: "",
      companions: 0,
      frontSeat: true,
      wheelchair: false,
      featureIds: [],
      maxRideTimeMinutes: 45,
      pickupDurationMinutes: 3,
      dropoffDurationMinutes: 4,
      medicalAlert: "",
    };
    const edited = await request(`/passengers/${created.id}`, "PATCH", edit, office);
    expect(edited.status).toBe(200);
    const editedPassenger = (await edited.json()).passenger;
    expect(editedPassenger).toEqual({
      ...created,
      name: "Pasajero Sintético Editado",
      homeAddress: "Pasaje Ficticio 303",
      homeLat: -26.81,
      homeLng: -65.22,
      accessNotes: null,
      companions: 0,
      frontSeat: true,
      wheelchair: false,
      featureIds: [],
      features: [],
      maxRideTimeMinutes: 45,
      pickupDurationMinutes: 3,
      dropoffDurationMinutes: 4,
      medicalAlert: null,
    });
    expect((await request("/passengers/99999", "PATCH", edit, office)).status).toBe(404);
    expect((await request("/passengers/3000000000", "PATCH", edit, office)).status).toBe(400);

    expect((await request(`/passengers/${created.id}/deactivate`, "PATCH", {}, office)).status).toBe(204);
    const second = await createPassenger(office, { name: "Pasajero Sintético Dos" });
    let listed = await request("/passengers", "GET", undefined, office);
    expect(listed.status).toBe(200);
    const passengers = (await listed.json()).passengers as Array<{ id: number; deactivatedAt: string | null }>;
    expect(passengers.map((p) => p.id)).toEqual([second.id, created.id]);
    expect(passengers[1].deactivatedAt).toEqual(expect.any(String));

    expect((await request(`/passengers/${created.id}/reactivate`, "PATCH", {}, office)).status).toBe(204);
    listed = await request("/passengers", "GET", undefined, office);
    expect((await listed.json()).passengers).toContainEqual(editedPassenger);
    expect((await request("/passengers/99999/deactivate", "PATCH", {}, office)).status).toBe(404);
    expect((await request("/passengers/99999/reactivate", "PATCH", {}, office)).status).toBe(404);
    expect((await request("/passengers/0/reactivate", "PATCH", {}, office)).status).toBe(400);

    expect(await passengerLog()).toEqual([
      {
        entity_id: String(created.id),
        action: "created",
        before_data: null,
        after_data: {
          ...validPassenger,
          featureIds: [ramp],
        },
      },
      {
        entity_id: String(created.id),
        action: "updated",
        before_data: { ...validPassenger, featureIds: [ramp] },
        after_data: { ...edit, accessNotes: null, medicalAlert: null },
      },
      { entity_id: String(created.id), action: "deactivated", before_data: { active: true }, after_data: { active: false, name: "Pasajero Sintético Editado" } },
      { entity_id: String(second.id), action: "created", before_data: null, after_data: { ...validPassenger, name: "Pasajero Sintético Dos" } },
      { entity_id: String(created.id), action: "reactivated", before_data: { active: false }, after_data: { active: true, name: "Pasajero Sintético Editado" } },
    ]);

    await migrationPool.query("REVOKE INSERT ON change_log FROM traslado_app");
    let withoutLog: Response[];
    try {
      withoutLog = [
        await request("/passengers", "POST", { ...validPassenger, name: "Sin Log" }, office),
        await request(`/passengers/${second.id}`, "PATCH", { ...validPassenger, name: "Sin Log" }, office),
        await request(`/passengers/${second.id}/deactivate`, "PATCH", {}, office),
      ];
    } finally {
      await migrationPool.query("GRANT INSERT ON change_log TO traslado_app");
    }
    expect(withoutLog.map((r) => r.status)).toEqual([500, 500, 500]);
    const rows = await storedPassengers();
    expect(rows.map((r) => r.name)).toEqual(["Pasajero Sintético Editado", "Pasajero Sintético Dos"]);
    expect(rows[1].deactivated_at).toBeNull();
  });

  it("accepts required Adaptaciones only from the Oficina's list", async () => {
    const office = await signIn("oficina-adaptaciones", "office");
    const ramp = await createFeature(office, "rampa para silla de ruedas");
    const belt = await createFeature(office, "cinturón postural");

    for (const featureIds of [[99999], [ramp, 99999], [0], ["1"], "rampa", [3_000_000_000]]) {
      const response = await request("/passengers", "POST", { ...validPassenger, featureIds }, office);
      expect(response.status, JSON.stringify(featureIds)).toBe(400);
    }
    expect(await storedPassengers()).toEqual([]);

    const created = await createPassenger(office, { featureIds: [ramp, belt, ramp] });
    expect(created.featureIds).toEqual([belt, ramp]);
    expect(created.features).toEqual(["cinturón postural", "rampa para silla de ruedas"]);

    const rejected = await request(`/passengers/${created.id}`, "PATCH", { ...validPassenger, featureIds: [belt, 99999] }, office);
    expect(rejected.status).toBe(400);
    const listed = (await (await request("/passengers", "GET", undefined, office)).json()).passengers;
    expect(listed[0].featureIds).toEqual([belt, ramp]);
  });

  it("stores no diagnosis, sex, gender or front-seat reason for a Pasajero", async () => {
    const office = await signIn("oficina-sin-diagnostico", "office");
    const columns = (await migrationPool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name LIKE 'passenger%'",
    )).rows.map((row) => String(row.column_name));
    expect(columns.filter((name) => /diagnos|sex|gender|genero|reason|motivo/i.test(name))).toEqual([]);

    const created = await createPassenger(office, {
      frontSeat: true,
      diagnosis: "dato que no se guarda",
      sex: "dato que no se guarda",
      gender: "dato que no se guarda",
      frontSeatReason: "dato que no se guarda",
    });
    expect(Object.keys(created).sort()).toEqual(PASSENGER_KEYS);
    const stored = JSON.stringify([await storedPassengers(), await passengerLog()]);
    expect(stored).not.toContain("dato que no se guarda");
  });

  it("requires Tiempo máximo a bordo and boarding and alighting minutes as positive whole numbers sent by the Oficina", async () => {
    const office = await signIn("oficina-minutos", "office");
    const created = await createPassenger(office);
    for (const field of ["maxRideTimeMinutes", "pickupDurationMinutes", "dropoffDurationMinutes"]) {
      const { [field]: _omitted, ...missing } = validPassenger as Record<string, unknown>;
      void _omitted;
      const invalid: Record<string, unknown>[] = [missing, ...[0, -5, 2.5, "5", null].map((value) => ({ ...validPassenger, [field]: value }))];
      for (const body of invalid) {
        expect((await request("/passengers", "POST", body, office)).status, `${field}: ${JSON.stringify(body[field])}`).toBe(400);
        expect((await request(`/passengers/${created.id}`, "PATCH", body, office)).status).toBe(400);
      }
    }
    const rows = await storedPassengers();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ max_ride_time_minutes: 60, pickup_duration_minutes: 5, dropoff_duration_minutes: 5 });
    await expect(
      migrationPool.query("UPDATE passengers SET pickup_duration_minutes = 0"),
    ).rejects.toThrow(/check constraint/i);
  });

  it("limits the medical alert to 140 characters", async () => {
    const office = await signIn("oficina-alerta", "office");
    const longest = "á".repeat(139) + "🚑";
    const created = await createPassenger(office, { medicalAlert: `  ${longest}  ` });
    expect(created.medicalAlert).toBe(longest);
    expect((await createPassenger(office, { medicalAlert: "   " })).medicalAlert).toBeNull();
    expect((await createPassenger(office, { medicalAlert: undefined })).medicalAlert).toBeNull();

    for (const medicalAlert of ["a".repeat(141), 42, ["alerta"]]) {
      expect((await request("/passengers", "POST", { ...validPassenger, medicalAlert }, office)).status).toBe(400);
      expect((await request(`/passengers/${created.id}`, "PATCH", { ...validPassenger, medicalAlert }, office)).status).toBe(400);
    }
    expect((await storedPassengers()).map((row) => row.medical_alert)).toEqual([longest, null, null]);
    await expect(
      migrationPool.query("UPDATE passengers SET medical_alert = $1", ["a".repeat(141)]),
    ).rejects.toThrow(/check constraint/i);
  });

  it("keeps every field of a deactivated Pasajero and offers no route to delete one", async () => {
    const office = await signIn("oficina-baja", "office");
    const ramp = await createFeature(office, "rampa para silla de ruedas");
    const created = await createPassenger(office, { featureIds: [ramp], frontSeat: true, companions: 2 });

    expect((await request(`/passengers/${created.id}/deactivate`, "PATCH", {}, office)).status).toBe(204);
    expect((await request(`/passengers/${created.id}/deactivate`, "PATCH", {}, office)).status).toBe(204);
    const [deactivated] = (await (await request("/passengers", "GET", undefined, office)).json()).passengers;
    expect(deactivated).toEqual({ ...created, deactivatedAt: expect.any(String) });

    expect((await request(`/passengers/${created.id}`, "DELETE", undefined, office)).status).toBe(404);
    const edit = await request(`/passengers/${created.id}`, "PATCH", { ...validPassenger, name: "Cambio sobre baja" }, office);
    expect(edit.status).toBe(409);
    expect(await edit.json()).toEqual({ error: "Cannot edit a deactivated passenger" });

    expect((await request(`/passengers/${created.id}/reactivate`, "PATCH", {}, office)).status).toBe(204);
    expect((await request(`/passengers/${created.id}/reactivate`, "PATCH", {}, office)).status).toBe(204);
    const [reactivated] = (await (await request("/passengers", "GET", undefined, office)).json()).passengers;
    expect(reactivated).toEqual(created);
    expect((await passengerLog()).map((row) => row.action)).toEqual(["created", "deactivated", "reactivated"]);
  });

  it("stores the number of Acompañantes as a whole number from 0 to 2", async () => {
    const office = await signIn("oficina-acompanantes", "office");
    for (const companions of [0, 1, 2]) {
      expect((await createPassenger(office, { companions })).companions).toBe(companions);
    }
    const { companions: _omitted, ...missing } = validPassenger;
    void _omitted;
    for (const body of [missing, ...[3, -1, 1.5, "1", true, null].map((companions) => ({ ...validPassenger, companions }))]) {
      expect((await request("/passengers", "POST", body, office)).status, JSON.stringify(body.companions)).toBe(400);
    }
    expect((await storedPassengers()).map((row) => row.companions)).toEqual([0, 1, 2]);
    await expect(migrationPool.query("UPDATE passengers SET companions = 3")).rejects.toThrow(/check constraint/i);
  });

  it("records the Asiento delantero requirement as a neutral yes or no per Pasajero", async () => {
    const office = await signIn("oficina-delantero", "office");
    const created = await createPassenger(office, { frontSeat: true });
    expect(created.frontSeat).toBe(true);
    for (const frontSeat of ["yes", 1, null, undefined]) {
      expect((await request("/passengers", "POST", { ...validPassenger, frontSeat }, office)).status, String(frontSeat)).toBe(400);
    }
    const edited = await request(`/passengers/${created.id}`, "PATCH", { ...validPassenger, frontSeat: false }, office);
    expect((await edited.json()).passenger.frontSeat).toBe(false);
    expect((await storedPassengers()).map((row) => row.front_seat)).toEqual([false]);
  });

  it("keeps boarding and alighting minutes per Pasajero", async () => {
    const office = await signIn("oficina-subida", "office");
    const usual = await createPassenger(office, { name: "Pasajero Habitual" });
    const quick = await createPassenger(office, { name: "Pasajero Rápido" });
    const edited = await request(`/passengers/${quick.id}`, "PATCH", {
      ...validPassenger,
      name: "Pasajero Rápido",
      pickupDurationMinutes: 3,
      dropoffDurationMinutes: 2,
    }, office);
    expect(edited.status).toBe(200);
    const listed = (await (await request("/passengers", "GET", undefined, office)).json()).passengers as typeof usual[];
    const minutes = Object.fromEntries(listed.map((p) => [p.id, [p.pickupDurationMinutes, p.dropoffDurationMinutes]]));
    expect(minutes).toEqual({ [usual.id]: [5, 5], [quick.id]: [3, 2] });
  });

  it("stores a Tiempo máximo a bordo of 40 minutes that the route validator enforces for that Pasajero", async () => {
    const office = await signIn("oficina-sonda", "office");
    const created = await createPassenger(office, { maxRideTimeMinutes: 40, companions: 0 });
    const [stored] = (await (await request("/passengers", "GET", undefined, office)).json()).passengers;
    expect(stored.maxRideTimeMinutes).toBe(40);

    const passenger = { ...stored, id: String(created.id) };
    const transfers = [{ id: "t1", passengerId: passenger.id, direction: "entrada" as const }];
    const vehicle = { id: "v1", capacity: { seats: 5, front: 1 } };
    const ride = (minutes: number) => [
      { id: "s1", transferId: "t1", type: "pickup" as const, plannedTime: "08:00", serviceDurationMinutes: 0 },
      { id: "s2", transferId: "t1", type: "dropoff" as const, plannedTime: `08:${String(minutes).padStart(2, "0")}`, serviceDurationMinutes: 0 },
    ];
    const rules = (minutes: number) =>
      validateRoute({ route: ride(minutes), passengers: [passenger], vehicle, transfers }).map((v) => v.rule);
    expect(rules(40)).not.toContain("max_ride_time_exceeded");
    expect(rules(45)).toContain("max_ride_time_exceeded");
  });
});
