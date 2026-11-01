import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { hashSessionToken } from "../../../packages/api/src/auth.js";
import { database } from "./session";

// The driver app's offline queue, on the production build with its service worker that e2e/global-setup.ts serves at
// E2E_DRIVER_URL. Synthetic data only.
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Tucuman" }).format(new Date());
type Seeded = { token: string; userIds: number[]; driverId: number; vehicleId: number; destinationId: number; passengerId: number;
  planId: number; routeId: number; transferId: number };
let seeded: Seeded;

/** A Chofer with a signed-in phone and today's published Recorrido: a salida from a school to the Pasajero's home. */
async function seed(): Promise<Seeded> {
  const pool = database();
  try {
    const id = async (sql: string, values: unknown[] = []) => Number((await pool.query(sql, values)).rows[0].id);
    const officeId = await id("INSERT INTO users (username, password_hash, role) VALUES ('oficina-offline-e2e', 'unused', 'office') RETURNING id");
    const userId = await id("INSERT INTO users (username, password_hash, role) VALUES ('chofer-offline-e2e', 'unused', 'driver') RETURNING id");
    const vehicleId = await id("INSERT INTO vehicles (plate, model, seats) VALUES ('OF001FL', 'Furgón Sintético', 8) RETURNING id");
    const driverId = await id(
      `INSERT INTO drivers (user_id, name, home_address, home_latitude, home_longitude, usual_vehicle_id)
       VALUES ($1, 'Chofer Offline E2E', 'Pasaje de Prueba 202', -26.84, -65.22, $2) RETURNING id`,
      [userId, vehicleId],
    );
    const destinationId = await id(
      `INSERT INTO destinations (name, kind, address, latitude, longitude)
       VALUES ('Escuela Offline E2E', 'school', 'Avenida Sintetica 303', -26.82, -65.2) RETURNING id`,
    );
    const passengerId = await id(
      `INSERT INTO passengers (name, home_address, home_latitude, home_longitude, companions, front_seat, wheelchair,
         max_ride_time_minutes, pickup_duration_minutes, dropoff_duration_minutes)
       VALUES ('Pasajero Offline E2E', 'Calle Inventada 101', -26.83, -65.21, 0, false, false, 60, 5, 5) RETURNING id`,
    );
    const motherId = await id(
      `INSERT INTO authorized_adults (passenger_id, name, dni, relation, phone, legal_guardian)
       VALUES ($1, 'Madre Offline E2E', '-1000001', 'madre', '381-000-0001', true) RETURNING id`,
      [passengerId],
    );
    await pool.query(
      "INSERT INTO consents (passenger_id, signed_by_adult_id, signed_at, other_adult_allowed) VALUES ($1, $2, '2026-10-01', false)",
      [passengerId, motherId],
    );
    const planId = await id("INSERT INTO daily_plans (plan_date) VALUES ($1) RETURNING id", [today]);
    const routeId = await id(
      "INSERT INTO routes (daily_plan_id, driver_id, vehicle_id, start_time, end_time, status) VALUES ($1, $2, $3, '06:00', '20:00', 'publicado') RETURNING id",
      [planId, driverId, vehicleId],
    );
    const transferId = await id(
      "INSERT INTO transfers (daily_plan_id, passenger_id, direction, destination_id, target_time, companions) VALUES ($1, $2, 'salida', $3, '13:00', 0) RETURNING id",
      [planId, passengerId, destinationId],
    );
    const versionId = await id(
      `INSERT INTO plan_versions (route_id, version, vehicle_id, driver_id, start_time, end_time, published_by, input_signature)
       VALUES ($1, 1, $2, $3, '06:00', '20:00', $4, 'c3-offline') RETURNING id`,
      [routeId, vehicleId, driverId, officeId],
    );
    await pool.query(
      "INSERT INTO plan_version_transfers (plan_version_id, transfer_id, companions, direct_distance_meters) VALUES ($1, $2, 0, 2000)",
      [versionId, transferId],
    );
    for (const [position, kind, time] of [[1, "pickup", "13:00"], [2, "dropoff", "13:20"]] as const) {
      await pool.query("INSERT INTO stops (route_id, transfer_id, kind, position) VALUES ($1, $2, $3, $4)", [routeId, transferId, kind, position]);
      await pool.query(
        `INSERT INTO plan_version_legs (plan_version_id, position, transfer_id, kind, distance_meters, duration_seconds, planned_time)
         VALUES ($1, $2, $3, $4, 1000, 600, $5)`,
        [versionId, position, transferId, kind, time],
      );
    }
    const token = randomBytes(32).toString("base64url");
    await pool.query("INSERT INTO sessions (user_id, token_hash, device_label) VALUES ($1, $2, 'Celular Playwright')", [userId, hashSessionToken(token)]);
    return { token, userIds: [officeId, userId], driverId, vehicleId, destinationId, passengerId, planId, routeId, transferId };
  } finally {
    await pool.end();
  }
}

async function cleanUp({ userIds, driverId, vehicleId, destinationId, passengerId, planId, routeId, transferId }: Seeded) {
  const pool = database();
  try {
    for (const [sql, value] of [
      ["DELETE FROM alerts WHERE transfer_id = $1", transferId],
      ["DELETE FROM marks WHERE transfer_id = $1", transferId],
      ["DELETE FROM plan_version_legs WHERE transfer_id = $1", transferId],
      ["DELETE FROM plan_version_transfers WHERE transfer_id = $1", transferId],
      ["DELETE FROM plan_versions WHERE route_id = $1", routeId],
      ["DELETE FROM stops WHERE route_id = $1", routeId],
      ["DELETE FROM transfers WHERE id = $1", transferId],
      ["DELETE FROM routes WHERE id = $1", routeId],
      ["DELETE FROM daily_plans WHERE id = $1", planId],
      ["DELETE FROM change_log WHERE actor_user_id = ANY($1::int[])", userIds],
      ["DELETE FROM sessions WHERE user_id = ANY($1::int[])", userIds],
      ["DELETE FROM drivers WHERE id = $1", driverId],
      ["DELETE FROM consents WHERE passenger_id = $1", passengerId],
      ["DELETE FROM authorized_adults WHERE passenger_id = $1", passengerId],
      ["DELETE FROM passengers WHERE id = $1", passengerId],
      ["DELETE FROM vehicles WHERE id = $1", vehicleId],
      ["DELETE FROM destinations WHERE id = $1", destinationId],
      ["DELETE FROM users WHERE id = ANY($1::int[])", userIds],
    ] as const) {
      await pool.query(sql, [value]);
    }
  } finally {
    await pool.end();
  }
}

async function storedMarks(transferId: number) {
  const pool = database();
  try {
    return (await pool.query("SELECT client_id, kind FROM marks WHERE transfer_id = $1 ORDER BY phone_time", [transferId])).rows;
  } finally {
    await pool.end();
  }
}

/** The Adultos autorizados the phone saved for a home drop-off, read from the app's IndexedDB without creating it. */
async function savedAdults(page: Page, transferId: number) {
  return await page.evaluate(async (id) => await new Promise<string[]>((resolve) => {
    const open = indexedDB.open("driver-app");
    open.onupgradeneeded = () => open.transaction?.abort();
    open.onerror = () => resolve([]);
    open.onsuccess = () => {
      const request = open.result.transaction("plan").objectStore("plan").get("current");
      request.onsuccess = () => {
        open.result.close();
        resolve(((request.result?.handovers?.[id]?.adults ?? []) as { name: string }[]).map((adult) => adult.name));
      };
    };
  }), transferId);
}

test.beforeEach(async () => {
  seeded = await seed();
});

test.afterEach(async () => {
  await cleanUp(seeded);
});

test("marks without signal, keeps the Marcas through a reload and confirms each once when the connection returns", async ({ context, page }) => {
  const driverUrl = process.env.E2E_DRIVER_URL!;
  await context.addCookies([{ name: "session", value: seeded.token, url: driverUrl, httpOnly: true, secure: true, sameSite: "Lax" }]);
  await page.goto(driverUrl);
  await expect(page.getByText("13:00 Pick up Pasajero Offline E2E")).toBeVisible();
  // The service worker precached the app, and the plan with who may receive at home is saved on the phone.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect.poll(() => savedAdults(page, seeded.transferId)).toEqual(["Madre Offline E2E"]);

  await context.setOffline(true);
  await page.getByRole("button", { name: "Subió" }).click();
  await expect(page.getByText("Saved on phone", { exact: true })).toHaveCount(2);

  await page.reload();
  await expect(page.getByText("13:20 Drop off Pasajero Offline E2E")).toBeVisible();
  await expect(page.getByText("Marked: Subió")).toHaveCount(2);
  await expect(page.getByText("Saved on phone", { exact: true })).toHaveCount(2);
  // The handover rule runs on the saved Adultos autorizados and Consentimiento.
  await page.getByRole("button", { name: "Entregado", exact: true }).click();
  await page.getByRole("button", { name: "Madre Offline E2E (madre)" }).click();
  await expect(page.getByText("Marked: Entregado")).toHaveCount(2);
  await expect(page.getByText("Saved on phone", { exact: true })).toHaveCount(2);
  expect(await storedMarks(seeded.transferId)).toEqual([]);

  await context.setOffline(false);
  await expect(page.getByText("Confirmed by server", { exact: true })).toHaveCount(2);
  const marks = await storedMarks(seeded.transferId);
  expect(marks.map((mark) => mark.kind)).toEqual(["subio", "entregado"]);
  expect(new Set(marks.map((mark) => mark.client_id)).size).toBe(2);

  // Opening the app again sends nothing twice.
  await page.reload();
  await expect(page.getByText("Confirmed by server", { exact: true })).toHaveCount(2);
  await expect(page.getByText("Marked: Entregado")).toHaveCount(2);
  expect(await storedMarks(seeded.transferId)).toEqual(marks);
});
