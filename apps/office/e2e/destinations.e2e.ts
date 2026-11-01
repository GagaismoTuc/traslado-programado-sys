import { expect, test, type Page, type Route } from "@playwright/test";
import { database, signInOffice } from "./session";

const suggestion = { lat: -26.83, lng: -65.21, displayName: "Calle Inventada 101, San Miguel de Tucumán" };
let blocked: string[] = [];
let requested: string[] = [];
let pageErrors: string[] = [];

test.beforeEach(async ({ page, context }) => {
  blocked = [];
  requested = [];
  pageErrors = [];
  // Failed responses the tests provoke on purpose are logged as "Failed to load resource"; anything else is a defect.
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) pageErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // Every request must stay on this machine: tiles, geocoding and fonts are never fetched from the network.
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    requested.push(url.href);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return await route.fallback();
    blocked.push(url.href);
    await route.abort("blockedbyclient");
  });
  await signInOffice(context);
});

test.afterEach(() => {
  expect(blocked).toEqual([]);
  expect(pageErrors).toEqual([]);
});

function gate() {
  let release = () => undefined as void;
  const opened = new Promise<void>((resolve) => { release = resolve; });
  return { opened, release };
}

async function openDestinations(page: Page) {
  await page.goto(`${process.env.E2E_BASE_URL}/destinations`);
  await expect(page.locator("[data-testid=pin-picker-map] canvas")).toBeVisible();
  await page.getByLabel("Name").fill("Escuela Sintetica E2E");
  await page.getByLabel("Kind").selectOption("therapy");
  await page.getByLabel("Address").fill("Calle Inventada 101");
}

async function mapPoint(page: Page, dx = 0, dy = 0) {
  const box = (await page.getByTestId("pin-picker-map").boundingBox())!;
  return { x: box.x + box.width / 2 + dx, y: box.y + box.height / 2 + dy };
}

async function drag(page: Page, selector: string, dx: number, dy: number) {
  const box = (await page.locator(selector).boundingBox())!;
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + dx, start.y + dy, { steps: 10 });
  await page.mouse.up();
}

async function pinText(page: Page) {
  const text = await page.getByText(/^Pin: /).textContent();
  const [lat, lng] = text!.replace("Pin: ", "").split(", ").map(Number);
  return { lat, lng };
}

async function savedDestinations(name: string) {
  const pool = database();
  try {
    const rows = await pool.query("SELECT id, kind, latitude, longitude FROM destinations WHERE name = $1", [name]);
    const changes = await pool.query("SELECT count(*)::int AS count FROM change_log WHERE entity = 'destination' AND entity_id = ANY($1)", [
      rows.rows.map((row) => String(row.id)),
    ]);
    return { rows: rows.rows, changes: changes.rows[0].count as number };
  } finally {
    await pool.query("DELETE FROM destinations WHERE name = $1", [name]);
    await pool.end();
  }
}

test("lets the Oficina change a Destino's Tolerancia de llegada", async ({ page }) => {
  const pool = database();
  try {
    await pool.query(
      `INSERT INTO destinations (name, kind, address, latitude, longitude, arrival_tolerance_minutes)
       VALUES ('Centro Tolerancia E2E', 'therapy', 'Avenida Sintetica 303', -26.82, -65.2, 0)`,
    );
    await page.goto(`${process.env.E2E_BASE_URL}/destinations`);
    const tolerance = page.getByLabel("Arrival tolerance of Centro Tolerancia E2E (minutes)");
    await expect(tolerance).toHaveValue("0");
    await tolerance.fill("15");
    await page.getByRole("listitem").filter({ hasText: "Centro Tolerancia E2E" }).getByRole("button", { name: "Save tolerance" }).click();
    await expect(page.getByRole("status")).toHaveText("Arrival tolerance of Centro Tolerancia E2E saved");
    const saved = await pool.query("SELECT arrival_tolerance_minutes FROM destinations WHERE name = 'Centro Tolerancia E2E'");
    expect(saved.rows).toEqual([{ arrival_tolerance_minutes: 15 }]);
  } finally {
    await pool.query("DELETE FROM destinations WHERE name = 'Centro Tolerancia E2E'");
    await pool.end();
  }
});

test("creates a Destino by dragging the pin", async ({ page }) => {
  await openDestinations(page);
  const save = page.getByRole("button", { name: "Save destination" });
  await expect(save).toBeDisabled();

  const center = await mapPoint(page);
  await page.mouse.click(center.x, center.y);
  await expect(page.locator(".pin-picker-pin")).toBeVisible();
  const placed = await pinText(page);
  await drag(page, ".pin-picker-pin", 120, 80);
  await expect(page.getByText(/^Pin: /)).not.toHaveText(`Pin: ${placed.lat.toFixed(6)}, ${placed.lng.toFixed(6)}`);
  const dragged = await pinText(page);
  expect(dragged.lat).toBeLessThan(placed.lat);
  expect(dragged.lng).toBeGreaterThan(placed.lng);

  await save.click();
  await expect(page.getByRole("status")).toHaveText("Destination saved");
  await expect(page.getByRole("listitem").filter({ hasText: "Escuela Sintetica E2E" })).toContainText("Therapy centre");
  const saved = await savedDestinations("Escuela Sintetica E2E");
  expect(saved.rows).toHaveLength(1);
  expect(saved.rows[0].kind).toBe("therapy");
  expect(saved.rows[0].latitude).toBeCloseTo(dragged.lat, 6);
  expect(saved.rows[0].longitude).toBeCloseTo(dragged.lng, 6);
  expect(saved.changes).toBe(1);
});

test("keeps Save disabled for an unmoved suggestion until the Oficina confirms or moves it", async ({ page }) => {
  await page.route("**/api/geocode", (route) => route.fulfill({ json: suggestion }));
  await openDestinations(page);
  const save = page.getByRole("button", { name: "Save destination" });

  await page.getByRole("button", { name: "Suggest pin" }).click();
  await expect(page.locator(".pin-picker-suggestion")).toBeVisible();
  await expect(page.getByText("Suggested pin: confirm it or move it")).toBeVisible();
  await expect(save).toBeDisabled();
  await page.getByRole("button", { name: "Confirm suggested pin" }).click();
  await expect(page.getByText("Pin: -26.830000, -65.210000")).toBeVisible();
  await expect(save).toBeEnabled();

  await page.getByRole("button", { name: "Suggest pin" }).click();
  await expect(save).toBeDisabled();
  await drag(page, ".pin-picker-suggestion", -90, -60);
  await expect(page.locator(".pin-picker-suggestion")).toHaveCount(0);
  const moved = await pinText(page);
  expect(moved.lat).toBeGreaterThan(suggestion.lat);
  expect(moved.lng).toBeLessThan(suggestion.lng);
  await expect(save).toBeEnabled();
});

test("calls Suggest pin only on request and disables it while the search is pending", async ({ page }) => {
  const pending = gate();
  const searches: string[] = [];
  await page.route("**/api/geocode", async (route) => {
    searches.push(route.request().postDataJSON().query);
    await pending.opened;
    await route.fulfill({ json: suggestion });
  });
  await openDestinations(page);
  await page.getByLabel("Address").pressSequentially(" esquina Pasaje de Prueba");
  expect(searches).toEqual([]);

  const button = page.getByRole("button", { name: "Suggest pin" });
  await button.click();
  await expect(page.getByRole("button", { name: "Searching..." })).toBeDisabled();
  pending.release();
  await expect(button).toBeEnabled();
  expect(searches).toEqual(["Calle Inventada 101 esquina Pasaje de Prueba"]);
});

test("shows a message and keeps manual pin placement usable when address search fails", async ({ page }) => {
  const failures: Array<[(route: Route) => Promise<void>, string]> = [
    [(route) => route.fallback(), "Address search is unavailable. Place the pin on the map by hand."],
    [(route) => route.fulfill({ status: 429, headers: { "Retry-After": "1" }, json: { error: "Too many address searches" } }),
      "Too many address searches. Wait a second and try again, or place the pin on the map by hand."],
    [(route) => route.fulfill({ status: 404, json: { error: "No match for this address" } }), "No match for this address. Place the pin on the map by hand."],
    [(route) => route.fulfill({ status: 502, json: { error: "Address search is unavailable" } }), "Address search is unavailable. Place the pin on the map by hand."],
    [(route) => route.abort("timedout"), "Address search is unavailable. Place the pin on the map by hand."],
  ];
  let current = failures[0][0];
  await page.route("**/api/geocode", (route) => current(route));
  await openDestinations(page);
  for (const [answer, message] of failures) {
    current = answer;
    await page.getByRole("button", { name: "Suggest pin" }).click();
    await expect(page.getByRole("alert")).toHaveText(message);
    await expect(page.locator(".pin-picker-suggestion")).toHaveCount(0);
  }

  const point = await mapPoint(page, 40, -30);
  await page.mouse.click(point.x, point.y);
  await expect(page.locator(".pin-picker-pin")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save destination" })).toBeEnabled();
});

test("disables Save while a create request is pending so a double click creates one Destino", async ({ page }) => {
  const pending = gate();
  await page.route("**/api/destinations", async (route) => {
    if (route.request().method() === "POST") await pending.opened;
    await route.fallback();
  });
  await openDestinations(page);
  await page.getByLabel("Name").fill("Escuela Doble Click");
  const center = await mapPoint(page);
  await page.mouse.click(center.x, center.y);

  await page.getByRole("button", { name: "Save destination" }).dblclick();
  await expect(page.getByRole("button", { name: "Saving..." })).toBeDisabled();
  pending.release();
  await expect(page.getByRole("status")).toHaveText("Destination saved");
  const saved = await savedDestinations("Escuela Doble Click");
  expect(saved.rows).toHaveLength(1);
  expect(saved.changes).toBe(1);
});

test("shows the map attribution and loads the map library only on the map screen", async ({ page }) => {
  await page.goto(`${process.env.E2E_BASE_URL}/`);
  await expect(page.getByRole("heading", { name: "Office sign-in" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(requested.filter((url) => url.includes("maplibre"))).toEqual([]);

  await page.goto(`${process.env.E2E_BASE_URL}/destinations`);
  await expect(page.locator("[data-testid=pin-picker-map] canvas")).toBeVisible();
  expect(requested.some((url) => url.includes("maplibre-gl"))).toBe(true);
  expect(requested).toContain(process.env.VITE_MAP_STYLE_URL);
  const attribution = page.locator(".maplibregl-ctrl-attrib");
  await expect(attribution.getByRole("link", { name: "OpenFreeMap" })).toBeVisible();
  await expect(attribution.getByRole("link", { name: "OpenStreetMap" })).toBeVisible();
});
