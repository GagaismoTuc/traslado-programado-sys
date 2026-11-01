import { expect, test } from "@playwright/test";
import { database, signInOffice } from "./session";

// A date `days` from today in Tucumán local time, the calendar /expiries uses.
function tucumanDate(days: number) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Tucuman" }).format(new Date(Date.now() + days * 86_400_000));
}

// Synthetic data only.
let vehicleId = 0;

test.beforeEach(async ({ context }) => {
  const pool = database();
  try {
    const vehicle = await pool.query("INSERT INTO vehicles (plate, model, seats) VALUES ('VE001NC', 'Furgón Sintético', 8) RETURNING id");
    vehicleId = vehicle.rows[0].id;
    await pool.query("INSERT INTO documents (vehicle_id, name, expires_on) VALUES ($1, 'VTV', $2)", [vehicleId, tucumanDate(4)]);
  } finally {
    await pool.end();
  }
  await signInOffice(context);
});

test.afterEach(async () => {
  const pool = database();
  try {
    await pool.query("DELETE FROM documents WHERE vehicle_id = $1", [vehicleId]);
    await pool.query("DELETE FROM vehicles WHERE id = $1", [vehicleId]);
  } finally {
    await pool.end();
  }
});

test("re-shows a dismissed expiry banner after a new document is added on the same page", async ({ page }) => {
  await page.goto(`${process.env.E2E_BASE_URL}/vehicles/${vehicleId}`);
  await expect(page.getByRole("alert")).toContainText("1 document is expired or expiring within 30 days");
  await page.getByRole("button", { name: "Dismiss until tomorrow" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);

  const addForm = page.locator("form").last();
  await addForm.locator('input[name="documentName"]').fill("Seguro");
  await addForm.locator('input[name="expiresOn"]').fill(tucumanDate(10));
  await page.getByRole("button", { name: "Add document" }).click();
  await expect(page.getByText("Document added")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("2 documents are expired or expiring within 30 days");
});
