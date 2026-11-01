import { expect, test, type Page } from "@playwright/test";
import { database, signInOffice } from "./session";

const PHONE = { width: 390, height: 844 };
const DAY = "2026-11-02";

// Synthetic data only.
async function seed() {
  const pool = database();
  try {
    await pool.query(
      `INSERT INTO destinations (name, kind, address, latitude, longitude)
       VALUES ('Escuela Plan E2E', 'school', 'Avenida Sintetica 303', -26.82, -65.2)`,
    );
    const passenger = await pool.query(
      `INSERT INTO passengers (name, home_address, home_latitude, home_longitude, companions, front_seat, wheelchair,
         max_ride_time_minutes, pickup_duration_minutes, dropoff_duration_minutes)
       VALUES ('Pasajero Plan E2E', 'Calle Inventada 101', -26.83, -65.21, 1, false, false, 60, 5, 5) RETURNING id`,
    );
    // A Traslado can only be assigned to a Recorrido once its Pasajero has a Consentimiento.
    const signer = await pool.query(
      `INSERT INTO authorized_adults (passenger_id, name, dni, relation, phone, legal_guardian)
       VALUES ($1, 'Madre Plan E2E', '-1000001', 'madre', '381-000-0001', true) RETURNING id`,
      [passenger.rows[0].id],
    );
    await pool.query(
      "INSERT INTO consents (passenger_id, signed_by_adult_id, signed_at, other_adult_allowed) VALUES ($1, $2, '2026-10-01', false)",
      [passenger.rows[0].id, signer.rows[0].id],
    );
    const vehicle = await pool.query("INSERT INTO vehicles (plate, model, seats) VALUES ('PL001AN', 'Furgón Sintético', 8) RETURNING id");
    const user = await pool.query("INSERT INTO users (username, password_hash, role) VALUES ('chofer-plan-e2e', 'unused', 'driver') RETURNING id");
    await pool.query(
      `INSERT INTO drivers (user_id, name, home_address, home_latitude, home_longitude, usual_vehicle_id)
       VALUES ($1, 'Chofer Plan E2E', 'Pasaje de Prueba 202', -26.84, -65.22, $2)`,
      [user.rows[0].id, vehicle.rows[0].id],
    );
  } finally {
    await pool.end();
  }
}

async function cleanUp() {
  const pool = database();
  try {
    for (const table of ["absences", "stops", "transfers", "routes", "daily_plans", "drivers", "consents", "authorized_adults", "passengers", "vehicles"]) {
      await pool.query(`DELETE FROM ${table}`);
    }
    await pool.query("DELETE FROM destinations WHERE name = 'Escuela Plan E2E'");
    await pool.query("DELETE FROM users WHERE username = 'chofer-plan-e2e'");
  } finally {
    await pool.end();
  }
}

async function expectNoSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);
}

test.beforeEach(async ({ context }) => {
  await cleanUp();
  await seed();
  await signInOffice(context);
});

test.afterEach(async () => {
  await cleanUp();
});

test("plans a day by hand at phone width without scrolling sideways", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto(`${process.env.E2E_BASE_URL}/plan`);
  await page.getByLabel("Day").fill(DAY);
  await page.getByRole("button", { name: "Create plan" }).click();
  await expect(page.getByText("Times are local to America/Argentina/Tucuman. Day total: 0.0 km")).toBeVisible();
  await expectNoSideScroll(page);

  await page.locator("select[name=passengerId]").selectOption({ label: "Pasajero Plan E2E" });
  await expect(page.locator("select[name=companions]")).toHaveValue("1");
  await page.locator("select[name=destinationId]").selectOption({ label: "Escuela Plan E2E" });
  await page.getByLabel("Arrival time").fill("08:00");
  await page.getByRole("button", { name: "Add Traslado" }).click();
  await expect(page.locator("strong", { hasText: "08:00 Pasajero Plan E2E: entrada, home → Escuela Plan E2E" })).toBeVisible();

  const newRoute = page.locator("form", { has: page.getByRole("heading", { name: "New Recorrido" }) });
  await newRoute.locator("select[name=driverId]").selectOption({ label: "Chofer Plan E2E" });
  await expect(newRoute.locator("select[name=vehicleId]")).toHaveValue(/\d+/);
  await newRoute.getByLabel("From").fill("07:00");
  await newRoute.getByLabel("To").fill("09:00");
  await newRoute.getByRole("button", { name: "Create Recorrido" }).click();
  await expect(page.locator("strong", { hasText: "Chofer Plan E2E 07:00-09:00" })).toBeVisible();

  await page.locator("li", { hasText: "08:00 Pasajero Plan E2E" }).locator("select").selectOption({ label: "Chofer Plan E2E 07:00-09:00" });
  await expect(page.getByText("Pick up Pasajero Plan E2E at home")).toBeVisible();
  await expect(page.getByText("Drop off Pasajero Plan E2E at Escuela Plan E2E")).toBeVisible();
  await expect(page.getByText("Draft - km not computed yet")).toBeVisible();
  await expectNoSideScroll(page);

  await page.getByRole("button", { name: "Register absence" }).click();
  await expect(page.getByText("Companions: 1 - Cancelled: absence")).toBeVisible();
  await expect(page.getByText("Pick up Pasajero Plan E2E at home")).toHaveCount(0);
  await expectNoSideScroll(page);
});

// Synthetic data only: one Traslado on each of two real Planes diarios.
async function seedTwoPlans(firstDay: string, secondDay: string) {
  const pool = database();
  try {
    const passenger = await pool.query("SELECT id FROM passengers WHERE name = 'Pasajero Plan E2E'");
    const destination = await pool.query("SELECT id FROM destinations WHERE name = 'Escuela Plan E2E'");
    const ids: number[] = [];
    for (const [planDate, targetTime] of [[firstDay, "08:00"], [secondDay, "09:00"]]) {
      const plan = await pool.query("INSERT INTO daily_plans (plan_date) VALUES ($1) RETURNING id", [planDate]);
      const transfer = await pool.query(
        `INSERT INTO transfers (daily_plan_id, passenger_id, direction, destination_id, target_time, companions)
         VALUES ($1, $2, 'entrada', $3, $4, 1) RETURNING id`,
        [plan.rows[0].id, passenger.rows[0].id, destination.rows[0].id, targetTime],
      );
      ids.push(transfer.rows[0].id);
    }
    return ids;
  } finally {
    await pool.end();
  }
}

async function transferStatus(id: number) {
  const pool = database();
  try {
    return (await pool.query("SELECT status FROM transfers WHERE id = $1", [id])).rows[0].status;
  } finally {
    await pool.end();
  }
}

test("does not render or mutate a daily plan whose answer arrives after the Oficina picked another day", async ({ page }) => {
  const selectedDay = DAY;
  const delayedDay = "2026-11-03";
  const [, delayedTransferId] = await seedTwoPlans(selectedDay, delayedDay);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const startedRequest = new Promise<void>((resolve) => { started = resolve; });
  let hold = true;
  await page.route(`**/api/daily-plans/${delayedDay}`, async (route) => {
    if (route.request().method() === "GET" && hold) {
      hold = false;
      started();
      await gate;
    }
    await route.continue();
  });

  await page.goto(`${process.env.E2E_BASE_URL}/plan`);
  await page.getByLabel("Day").fill(delayedDay);
  await startedRequest;
  const selectedRead = page.waitForResponse((response) =>
    response.request().method() === "GET" && response.url().endsWith(`/api/daily-plans/${selectedDay}`));
  await page.getByLabel("Day").fill(selectedDay);
  await selectedRead;
  await expect(page.locator("strong", { hasText: "08:00 Pasajero Plan E2E" })).toBeVisible();

  const delayedRead = page.waitForResponse((response) =>
    response.request().method() === "GET" && response.url().endsWith(`/api/daily-plans/${delayedDay}`));
  release();
  await delayedRead;
  await page.waitForTimeout(200);

  await expect(page.getByLabel("Day")).toHaveValue(selectedDay);
  await expect(page.locator("strong", { hasText: "09:00 Pasajero Plan E2E" })).toHaveCount(0);
  await expect(page.locator("strong", { hasText: "08:00 Pasajero Plan E2E" })).toBeVisible();
  await page.getByRole("button", { name: "Register absence" }).click();
  await expect(page.getByText("Absence registered")).toBeVisible();
  expect(await transferStatus(delayedTransferId)).toBe("planificado");
});
