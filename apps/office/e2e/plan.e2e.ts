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
    await pool.query(
      `INSERT INTO passengers (name, home_address, home_latitude, home_longitude, companions, front_seat, wheelchair,
         max_ride_time_minutes, pickup_duration_minutes, dropoff_duration_minutes)
       VALUES ('Pasajero Plan E2E', 'Calle Inventada 101', -26.83, -65.21, 1, false, false, 60, 5, 5)`,
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
    for (const table of ["absences", "stops", "transfers", "routes", "daily_plans", "drivers", "passengers", "vehicles"]) {
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
