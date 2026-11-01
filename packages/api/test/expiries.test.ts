import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp, type Router, type RoutingHealth } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { createPool } from "../src/db.js";
import { getSessionCookie, signInOffice } from "./helpers/office-session.js";

const appPool = createPool(process.env.TEST_DATABASE_URL!);
const migrationPool = createPool(process.env.TEST_MIGRATION_DATABASE_URL!);
const routingUp: RoutingHealth = { osrm: async () => undefined, vroom: async () => undefined };
// Stand-in for OSRM: 1 km and 2 minutes for every leg.
const router: Router = async (points) => points.slice(1).map(() => ({ distanceMeters: 1000, durationSeconds: 120 }));
const clock = { now: new Date("2026-10-28T15:00:00.000Z") };
const app = createApp({ db: appPool, routing: routingUp, router, config: { serverEpoch: "expiries-test", now: () => clock.now } });

const DAY = "2026-11-02";
const DEFAULT_VEHICLE_DOCUMENTS = ["VTV", "Service"];
const DEFAULT_DRIVER_DOCUMENTS = ["Carnet de manejo", "Certificado de sanidad", "Certificado de buena conducta"];

beforeEach(() => {
  clock.now = new Date("2026-10-28T15:00:00.000Z");
});

afterAll(async () => {
  await Promise.all([appPool.end(), migrationPool.end()]);
});

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
  const result = await migrationPool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id",
    [username, await hashPassword(`${username}-password`), role],
  );
  return Number(result.rows[0].id);
}

async function ok(response: Response | Promise<Response>, status = 201) {
  const resolved = await response;
  expect(resolved.status, await resolved.clone().text()).toBe(status);
  return resolved.status === 204 ? null : await resolved.json();
}

async function stored(sql: string, values: unknown[] = []) {
  return (await migrationPool.query(sql, values)).rows;
}

const documentChanges = () => stored(
  "SELECT entity_id, action, before_data, after_data FROM change_log WHERE entity = 'document' ORDER BY id",
);

/** An Oficina session with helpers to add Vehículos and Choferes (synthetic data only) and read their documents. */
async function setup(name: string) {
  await seedUser(`oficina-${name}`, "office");
  const office = (await signInOffice(app, migrationPool, `oficina-${name}`, `oficina-${name}-password`)).cookie;
  const send = (path: string, method: string, body?: unknown) => request(path, method, body, office);
  let plates = 0;
  const vehicle = async () => (await ok(send("/vehicles", "POST", {
    plate: `${name.slice(0, 3).toUpperCase()}${String(++plates).padStart(3, "0")}`, model: "Furgón Sintético", seats: 8,
  }))).vehicle as { id: number; plate: string };
  let drivers = 0;
  const driver = async (usualVehicleId: number | null = null) => {
    const username = `chofer-${name}-${++drivers}`;
    const userId = await seedUser(username, "driver");
    return (await ok(send("/drivers", "POST", {
      userId, name: `Chofer ${username}`, homeAddress: "Pasaje de Prueba 202", homeLat: -26.85, homeLng: -65.23, usualVehicleId,
    }))).driver as { id: number; name: string };
  };
  const documents = async (owner: "vehicles" | "drivers", id: number) =>
    (await ok(send(`/${owner}/${id}/documents`, "GET"), 200)).documents as { id: number; name: string; expiresOn: string | null }[];
  const date = async (owner: "vehicles" | "drivers", id: number, name: string, expiresOn: string | null) => {
    const document = (await documents(owner, id)).find((item) => item.name === name)!;
    return (await ok(send(`/documents/${document.id}`, "PATCH", { name, expiresOn }), 200)).document;
  };
  const expiries = async () => await ok(send("/expiries", "GET"), 200);
  return { office, send, vehicle, driver, documents, date, expiries };
}

describe("Vencimientos of Vehículos and Choferes", () => {
  it("stores only the document name and its date and refuses a file, scan or photo", async () => {
    const { send, vehicle } = await setup("r1");
    const van = await vehicle();
    const changesBefore = await documentChanges();
    for (const extra of [{ file: "data:application/pdf;base64,JVBERi0=" }, { scan: "c2Nhbg==" }, { photo: "cGhvdG8=" }]) {
      const refused = await send(`/vehicles/${van.id}/documents`, "POST", { name: "Seguro", expiresOn: "2026-12-01", ...extra });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: "Only a document's name and expiry date are stored" });
      const vtv = (await stored("SELECT id FROM documents WHERE vehicle_id = $1 AND name = 'VTV'", [van.id]))[0];
      const edit = await send(`/documents/${vtv.id}`, "PATCH", { name: "VTV", expiresOn: "2026-12-01", ...extra });
      expect(edit.status).toBe(400);
    }
    expect(await stored("SELECT name, expires_on FROM documents WHERE vehicle_id = $1 ORDER BY id", [van.id]))
      .toEqual([{ name: "VTV", expires_on: null }, { name: "Service", expires_on: null }]);
    expect(await documentChanges()).toEqual(changesBefore);
    expect((await stored(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'documents' ORDER BY ordinal_position",
    )).map((row) => row.column_name)).toEqual(["id", "vehicle_id", "driver_id", "name", "expires_on", "created_at"]);
  });

  it("warns naming the expired document when assigning and when publishing a Recorrido, and never blocks", async () => {
    const { send, vehicle, driver, date } = await setup("r2");
    const van = await vehicle();
    const spare = await vehicle();
    const chofer = await driver(van.id);
    // Expired on the Recorrido's day; one dated that same day is still valid.
    await date("vehicles", van.id, "VTV", "2026-11-01");
    await date("vehicles", van.id, "Service", DAY);
    await date("drivers", chofer.id, "Carnet de manejo", "2026-10-15");
    await date("vehicles", spare.id, "Service", "2026-10-30");
    const vanWarning = {
      owner: "vehicle", ownerLabel: van.plate, document: "VTV", expiresOn: "2026-11-01",
      message: `Vehículo ${van.plate}: VTV expired on 2026-11-01`,
    };
    const choferWarning = {
      owner: "driver", ownerLabel: chofer.name, document: "Carnet de manejo", expiresOn: "2026-10-15",
      message: `Chofer ${chofer.name}: Carnet de manejo expired on 2026-10-15`,
    };
    const spareWarning = {
      owner: "vehicle", ownerLabel: spare.plate, document: "Service", expiresOn: "2026-10-30",
      message: `Vehículo ${spare.plate}: Service expired on 2026-10-30`,
    };
    await ok(send("/daily-plans", "POST", { date: DAY }));

    const created = await ok(send(`/daily-plans/${DAY}/routes`, "POST", { driverId: chofer.id, startTime: "07:00", endTime: "09:00" }));
    const routeId = created.route.id as number;
    expect(created.warnings).toEqual([{ routeId, ...vanWarning }, { routeId, ...choferWarning }]);

    const changed = await ok(send(`/routes/${routeId}`, "PATCH", { vehicleId: spare.id }), 200);
    expect(changed.route.vehicleId).toBe(spare.id);
    expect(changed.warnings).toEqual([{ routeId, ...spareWarning }, { routeId, ...choferWarning }]);

    const passengerId = (await ok(send("/passengers", "POST", {
      name: "Pasajero Sintético r2", homeAddress: "Calle Inventada 101", homeLat: -26.83, homeLng: -65.21, companions: 0,
      frontSeat: false, wheelchair: false, maxRideTimeMinutes: 60, pickupDurationMinutes: 5, dropoffDurationMinutes: 5,
    }))).passenger.id;
    const signer = (await ok(send(`/passengers/${passengerId}/authorized-adults`, "POST", {
      name: "Madre Sintética", dni: "-1000002", relation: "madre", phone: "381-000-0002", legalGuardian: true,
    }))).adult.id;
    await ok(send(`/passengers/${passengerId}/consent`, "POST", { signedByAdultId: signer, signedAt: "2026-10-01", otherAdultAllowed: false }));
    const destinationId = (await ok(send("/destinations", "POST", {
      name: "Escuela r2", kind: "school", address: "Avenida Sintetica 303", lat: -26.82, lng: -65.2,
    }))).destination.id;
    const transfer = async (targetTime: string) => (await ok(send(`/daily-plans/${DAY}/transfers`, "POST", {
      passengerId, direction: "entrada", destinationId, targetTime,
    }))).transfer.id as number;
    await ok(send(`/transfers/${await transfer("08:00")}`, "PATCH", { routeId }), 200);

    const published = await ok(send(`/routes/${routeId}/publish`, "POST", {}));
    expect(published.version.version).toBe(1);
    expect(published.warnings).toEqual([{ routeId, ...spareWarning }, { routeId, ...choferWarning }]);

    const other = await driver(van.id);
    await date("drivers", other.id, "Certificado de sanidad", "2026-11-01");
    const day = await ok(send(`/daily-plans/${DAY}/driver-days`, "POST", { driverId: other.id, transferIds: [await transfer("12:00")] }));
    const dayRouteId = day.routes[0].id as number;
    const otherWarning = {
      owner: "driver", ownerLabel: other.name, document: "Certificado de sanidad", expiresOn: "2026-11-01",
      message: `Chofer ${other.name}: Certificado de sanidad expired on 2026-11-01`,
    };
    expect(day.warnings).toEqual([{ routeId: dayRouteId, ...vanWarning }, { routeId: dayRouteId, ...otherWarning }]);

    const summary = await ok(send(`/daily-plans/${DAY}/publish`, "POST"), 200);
    expect(summary.published).toEqual([{ routeId: dayRouteId, version: 1 }]);
    expect(summary.unchanged).toEqual([routeId]);
    expect(summary.warnings).toEqual([
      { routeId, ...spareWarning }, { routeId, ...choferWarning },
      { routeId: dayRouteId, ...vanWarning }, { routeId: dayRouteId, ...otherWarning },
    ]);
  });

  it("keeps assignment success when expiry lookup fails after commit", async () => {
    const { send, vehicle, driver } = await setup("r2b");
    const van = await vehicle();
    const chofer = await driver(van.id);
    const date = "2026-11-05";
    await ok(send("/daily-plans", "POST", { date }));
    const before = await stored("SELECT count(*)::int AS count FROM routes");
    await migrationPool.query("REVOKE SELECT ON documents FROM traslado_app");
    let response: Response;
    try {
      response = await send("/daily-plans/" + date + "/routes", "POST", {
        driverId: chofer.id, startTime: "07:00", endTime: "09:00",
      });
    } finally {
      await migrationPool.query("GRANT SELECT ON documents TO traslado_app");
    }
    const after = await stored("SELECT count(*)::int AS count FROM routes");
    expect({ status: response!.status, count: after[0].count })
      .toEqual({ status: 201, count: before[0].count + 1 });
    expect(await response!.json()).toMatchObject({ warnings: [], warningsUnavailable: true });
  });

  it("lists a document as valid through its date and expired from the next day in Tucumán local time", async () => {
    const { vehicle, date, expiries } = await setup("r3");
    const vans = [await vehicle(), await vehicle(), await vehicle(), await vehicle()];
    await date("vehicles", vans[0].id, "VTV", "2026-11-20");
    await date("vehicles", vans[1].id, "VTV", "2026-12-30");
    await date("vehicles", vans[2].id, "VTV", "2026-10-27");
    await date("vehicles", vans[3].id, "VTV", "2026-10-28");
    const listed = (panel: { documents: { owner: { label: string }; expiresOn: string; daysLeft: number }[] }) =>
      panel.documents.map((item) => ({ plate: item.owner.label, expiresOn: item.expiresOn, daysLeft: item.daysLeft }));

    const panel = await expiries();
    expect(panel.today).toBe("2026-10-28");
    expect(listed(panel)).toEqual([
      { plate: vans[2].plate, expiresOn: "2026-10-27", daysLeft: -1 },
      { plate: vans[3].plate, expiresOn: "2026-10-28", daysLeft: 0 },
      { plate: vans[0].plate, expiresOn: "2026-11-20", daysLeft: 23 },
    ]);
    expect(panel.documents[0]).toEqual({
      id: expect.any(Number), name: "VTV", expiresOn: "2026-10-27", daysLeft: -1, owner: { kind: "vehicle", id: vans[2].id, label: vans[2].plate },
    });

    // 23:59 of 2026-10-28 in Tucumán (UTC-3) is already 2026-10-29 in UTC: the VTV of that day is still valid.
    clock.now = new Date("2026-10-29T02:59:00.000Z");
    expect(listed(await expiries())[1]).toEqual({ plate: vans[3].plate, expiresOn: "2026-10-28", daysLeft: 0 });
    clock.now = new Date("2026-10-29T03:00:00.000Z");
    const nextDay = await expiries();
    expect(nextDay.today).toBe("2026-10-29");
    expect(listed(nextDay)[1]).toEqual({ plate: vans[3].plate, expiresOn: "2026-10-28", daysLeft: -1 });
  });

  it("starts alerting 30 days before the date", async () => {
    const { vehicle, date, expiries } = await setup("r4");
    const inThirty = await vehicle();
    const inThirtyOne = await vehicle();
    await date("vehicles", inThirty.id, "VTV", "2026-11-27");
    await date("vehicles", inThirtyOne.id, "VTV", "2026-11-28");
    const panel = await expiries();
    expect(panel.documents.map((item: { owner: { label: string }; daysLeft: number }) => [item.owner.label, item.daysLeft]))
      .toEqual([[inThirty.plate, 30]]);
  });

  it("accepts a past date and rejects an invalid one with a message naming the field", async () => {
    const { send, vehicle, driver, documents } = await setup("r5");
    const van = await vehicle();
    const chofer = await driver();
    const past = await ok(send(`/drivers/${chofer.id}/documents`, "POST", { name: "Curso de primeros auxilios", expiresOn: "2020-01-31" }));
    expect(past.document).toEqual({ id: expect.any(Number), vehicleId: null, driverId: chofer.id, name: "Curso de primeros auxilios", expiresOn: "2020-01-31" });
    const vtv = (await documents("vehicles", van.id))[0];
    expect((await ok(send(`/documents/${vtv.id}`, "PATCH", { name: "VTV", expiresOn: "2025-06-30" }), 200)).document.expiresOn).toBe("2025-06-30");

    const before = await stored("SELECT id, name, expires_on FROM documents ORDER BY id");
    const changesBefore = await documentChanges();
    for (const expiresOn of ["2026-02-30", "28/10/2026", "2026-1-5", "", 20261028]) {
      for (const response of [
        await send(`/vehicles/${van.id}/documents`, "POST", { name: "Seguro", expiresOn }),
        await send(`/documents/${vtv.id}`, "PATCH", { name: "VTV", expiresOn }),
      ]) {
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "Invalid expiry date (expiresOn): use YYYY-MM-DD" });
      }
    }
    // An edit replaces both fields, so leaving the date out is refused instead of clearing it.
    const noDate = await send(`/documents/${vtv.id}`, "PATCH", { name: "VTV" });
    expect(noDate.status).toBe(400);
    expect(await noDate.json()).toEqual({ error: "Send expiresOn: a date as YYYY-MM-DD, or null for no date" });
    const noName = await send(`/vehicles/${van.id}/documents`, "POST", { name: "  ", expiresOn: "2026-12-01" });
    expect(noName.status).toBe(400);
    expect(await noName.json()).toEqual({ error: "Invalid name: write the document's name" });
    expect(await stored("SELECT id, name, expires_on FROM documents ORDER BY id")).toEqual(before);
    expect(await documentChanges()).toEqual(changesBefore);
  });

  it("shows a document with no date in its own group, not counted as expired", async () => {
    const { vehicle, date, expiries } = await setup("r6");
    const van = await vehicle();
    await date("vehicles", van.id, "VTV", "2026-10-01");
    const panel = await expiries();
    expect(panel.documents.map((item: { name: string }) => item.name)).toEqual(["VTV"]);
    expect(panel.undated).toEqual([
      { id: expect.any(Number), name: "Service", expiresOn: null, daysLeft: null, owner: { kind: "vehicle", id: van.id, label: van.plate } },
    ]);
  });

  it("removes a seeded document and records the removal in the change log", async () => {
    const { send, vehicle, documents } = await setup("r7");
    const van = await vehicle();
    const service = (await documents("vehicles", van.id)).find((item) => item.name === "Service")!;
    expect(await ok(send(`/documents/${service.id}`, "DELETE"), 204)).toBeNull();
    expect((await documents("vehicles", van.id)).map((item) => item.name)).toEqual(["VTV"]);
    expect((await documentChanges()).at(-1)).toEqual({
      entity_id: String(service.id), action: "removed", before_data: { vehicleId: van.id, driverId: null, name: "Service", expiresOn: null }, after_data: null,
    });
    const again = await send(`/documents/${service.id}`, "DELETE");
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ error: "Document not found" });
  });

  it("does not let a Chofer read or write Vencimientos", async () => {
    const { send, vehicle, driver, documents } = await setup("r8");
    const van = await vehicle();
    const chofer = await driver(van.id);
    const vtv = (await documents("vehicles", van.id))[0];
    await seedUser("chofer-r8-reader", "driver");
    const login = await request("/auth/login", "POST", { username: "chofer-r8-reader", password: "chofer-r8-reader-password", deviceLabel: "Phone" });
    const choferCookie = getSessionCookie(login).cookie;
    const before = await stored("SELECT id, name, expires_on FROM documents ORDER BY id");
    const changesBefore = await documentChanges();
    const attempts: [string, string, unknown?][] = [
      ["/expiries", "GET"],
      [`/vehicles/${van.id}/documents`, "GET"],
      [`/drivers/${chofer.id}/documents`, "GET"],
      [`/vehicles/${van.id}/documents`, "POST", { name: "Seguro", expiresOn: "2026-12-01" }],
      [`/drivers/${chofer.id}/documents`, "POST", { name: "Seguro", expiresOn: "2026-12-01" }],
      [`/documents/${vtv.id}`, "PATCH", { name: "VTV", expiresOn: "2026-12-01" }],
      [`/documents/${vtv.id}`, "DELETE"],
    ];
    for (const [path, method, body] of attempts) {
      const asChofer = await request(path, method, body, choferCookie);
      expect(asChofer.status).toBe(403);
      expect(await asChofer.json()).toEqual({ error: "Office role required" });
      expect((await request(path, method, body)).status).toBe(401);
    }
    expect(await stored("SELECT id, name, expires_on FROM documents ORDER BY id")).toEqual(before);
    expect(await documentChanges()).toEqual(changesBefore);
    expect((await send("/expiries", "GET")).status).toBe(200);
  });

  it("alerts the Oficina about VTV, service, driving licence, health and criminal-record certificates", async () => {
    const { vehicle, driver, documents, date, expiries } = await setup("r9");
    const van = await vehicle();
    const chofer = await driver();
    const vehicleDocuments = await documents("vehicles", van.id);
    const driverDocuments = await documents("drivers", chofer.id);
    expect(vehicleDocuments.map(({ name, expiresOn }) => ({ name, expiresOn })))
      .toEqual(DEFAULT_VEHICLE_DOCUMENTS.map((name) => ({ name, expiresOn: null })));
    expect(driverDocuments.map(({ name, expiresOn }) => ({ name, expiresOn })))
      .toEqual(DEFAULT_DRIVER_DOCUMENTS.map((name) => ({ name, expiresOn: null })));
    expect((await documentChanges()).map((row) => [row.action, row.after_data])).toEqual([
      ...DEFAULT_VEHICLE_DOCUMENTS.map((name) => ["created", { vehicleId: van.id, driverId: null, name, expiresOn: null }]),
      ...DEFAULT_DRIVER_DOCUMENTS.map((name) => ["created", { vehicleId: null, driverId: chofer.id, name, expiresOn: null }]),
    ]);

    for (const name of DEFAULT_VEHICLE_DOCUMENTS) await date("vehicles", van.id, name, "2026-10-20");
    for (const name of DEFAULT_DRIVER_DOCUMENTS) await date("drivers", chofer.id, name, "2026-10-20");
    const panel = await expiries();
    // Same date: ordered by owner ("Chofer chofer-r9-1" before plate "R9001"), then as entered.
    expect(panel.documents.map((item: { name: string; owner: { label: string }; daysLeft: number }) => [item.owner.label, item.name, item.daysLeft]))
      .toEqual([
        ...DEFAULT_DRIVER_DOCUMENTS.map((name) => [chofer.name, name, -8]),
        ...DEFAULT_VEHICLE_DOCUMENTS.map((name) => [van.plate, name, -8]),
      ]);
    expect(panel.undated).toEqual([]);
  });

  it("lets the Oficina add, edit and remove a document on a Vehículo or a Chofer, including the seeded ones, with change log entries", async () => {
    const { send, vehicle, driver, documents } = await setup("ac2");
    const van = await vehicle();
    const chofer = await driver();
    const seguro = await ok(send(`/vehicles/${van.id}/documents`, "POST", { name: "  Seguro  ", expiresOn: "2027-01-15" }));
    expect(seguro.document).toEqual({ id: expect.any(Number), vehicleId: van.id, driverId: null, name: "Seguro", expiresOn: "2027-01-15" });
    const licencia = await ok(send(`/drivers/${chofer.id}/documents`, "POST", { name: "Licencia profesional" }));
    expect(licencia.document).toEqual({ id: expect.any(Number), vehicleId: null, driverId: chofer.id, name: "Licencia profesional", expiresOn: null });
    const duplicate = await send(`/vehicles/${van.id}/documents`, "POST", { name: "vtv" });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: "A document with this name already exists" });

    const carnet = (await documents("drivers", chofer.id))[0];
    const edited = await ok(send(`/documents/${carnet.id}`, "PATCH", { name: "Carnet profesional", expiresOn: "2027-03-01" }), 200);
    expect(edited.document).toEqual({ id: carnet.id, vehicleId: null, driverId: chofer.id, name: "Carnet profesional", expiresOn: "2027-03-01" });
    const changesAfterEdit = await documentChanges();
    expect(await ok(send(`/documents/${carnet.id}`, "PATCH", { name: "Carnet profesional", expiresOn: "2027-03-01" }), 200)).toEqual(edited);
    expect(await documentChanges()).toEqual(changesAfterEdit);
    await ok(send(`/documents/${seguro.document.id}`, "DELETE"), 204);

    expect((await documents("vehicles", van.id)).map((item) => item.name)).toEqual(["VTV", "Service"]);
    expect((await documents("drivers", chofer.id)).map((item) => [item.name, item.expiresOn])).toEqual([
      ["Carnet profesional", "2027-03-01"], ["Certificado de sanidad", null], ["Certificado de buena conducta", null], ["Licencia profesional", null],
    ]);
    expect((await documentChanges()).slice(5)).toEqual([
      { entity_id: String(seguro.document.id), action: "created", before_data: null, after_data: { vehicleId: van.id, driverId: null, name: "Seguro", expiresOn: "2027-01-15" } },
      { entity_id: String(licencia.document.id), action: "created", before_data: null, after_data: { vehicleId: null, driverId: chofer.id, name: "Licencia profesional", expiresOn: null } },
      {
        entity_id: String(carnet.id), action: "updated",
        before_data: { vehicleId: null, driverId: chofer.id, name: "Carnet de manejo", expiresOn: null },
        after_data: { vehicleId: null, driverId: chofer.id, name: "Carnet profesional", expiresOn: "2027-03-01" },
      },
      { entity_id: String(seguro.document.id), action: "removed", before_data: { vehicleId: van.id, driverId: null, name: "Seguro", expiresOn: "2027-01-15" }, after_data: null },
    ]);
    expect((await send("/vehicles/999999/documents", "GET")).status).toBe(404);
    expect((await send("/drivers/999999/documents", "POST", { name: "Seguro" })).status).toBe(404);
  });
});
