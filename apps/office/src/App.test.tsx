import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { MAP_STYLE_URL, PinPicker } from "./PinPicker";
import pinPickerSource from "./PinPicker.tsx?raw";

afterEach(() => vi.unstubAllGlobals());

describe("office screens", () => {
  it("renders the office sign-in page", () => {
    const markup = renderToStaticMarkup(<App />);
    expect(markup).toContain("<h1>Office sign-in</h1>");
    expect(markup).toContain('name="username"');
    expect(markup).toContain('type="password"');
  });

  it("renders the user-management page at /users", () => {
    vi.stubGlobal("window", { location: { pathname: "/users" } });
    const markup = renderToStaticMarkup(<App />);
    expect(markup).toContain("<h1>Users</h1>");
    expect(markup).toContain("Create user");
    expect(markup).toContain('<option value="office">Office</option>');
    expect(markup).toContain('<option value="driver">Driver</option>');
  });

  it("renders the second-factor page at /second-factor", () => {
    vi.stubGlobal("window", { location: { pathname: "/second-factor" } });
    const markup = renderToStaticMarkup(<App />);
    expect(markup).toContain("<h1>Two-factor authentication</h1>");
    expect(markup).toContain("Checking sign-in...");
  });

  it("renders the Destinos page at /destinations without loading the map library", () => {
    vi.stubGlobal("window", { location: { pathname: "/destinations" } });
    const markup = renderToStaticMarkup(<App />);
    expect(markup).toContain("<h1>Destinations</h1>");
    for (const field of ['name="name"', 'name="kind"', 'name="address"', 'name="accessNotes"']) expect(markup).toContain(field);
    for (const kind of ["school", "clinic", "therapy", "day_centre", "other"]) expect(markup).toContain(`<option value="${kind}">`);
    expect(markup).toContain("Suggest pin");
    expect(markup).toMatch(/<button type="submit" disabled="">Save destination<\/button>/);
    expect(pinPickerSource).not.toMatch(/^import\s+(?!type\b)[^;]*["']maplibre-gl["']/m);
    expect(pinPickerSource).toContain('import("maplibre-gl")');
  });

  it("keeps the pin picker free of Destino code with value, onChange and suggestion props", () => {
    const imports = [...pinPickerSource.matchAll(/from\s+["']([^"']+)["']|import\(["']([^"']+)["']\)/g)].map((match) => match[1] ?? match[2]);
    expect(new Set(imports)).toEqual(new Set(["react", "maplibre-gl", "maplibre-gl/dist/maplibre-gl-worker.mjs?url", "maplibre-gl/dist/maplibre-gl.css"]));
    expect(pinPickerSource).not.toMatch(/destination/i);
    const markup = renderToStaticMarkup(<PinPicker value={{ lat: -26.8241, lng: -65.2036 }} onChange={() => undefined} suggestion={null} />);
    expect(markup).toContain("Pin: -26.824100, -65.203600");
    expect(MAP_STYLE_URL).toBe("https://tiles.openfreemap.org/styles/liberty");
  });

  it("renders the Adaptaciones page at /vehicle-features with create form and navigation", () => {
    vi.stubGlobal("window", { location: { pathname: "/vehicle-features" } });
    const markup = renderToStaticMarkup(<App />);
    expect(markup).toContain("<h1>Vehicle features</h1>");
    expect(markup).toContain('name="name"');
    expect(markup).toContain("Save feature");
    expect(markup).toContain('href="/vehicles"');
    expect(markup).toContain('href="/drivers"');
  });

  it("renders the Vehículos page at /vehicles with plate, model, seats and front: 1", () => {
    vi.stubGlobal("window", { location: { pathname: "/vehicles" } });
    const markup = renderToStaticMarkup(<App />);
    expect(markup).toContain("<h1>Vehicles</h1>");
    for (const field of ['name="plate"', 'name="model"', 'name="seats"', 'name="front"']) {
      expect(markup).toContain(field);
    }
    expect(markup).toContain('value="1"');
    expect(markup).toContain("Save vehicle");
  });

  it("renders the Choferes page at /drivers with user link, usual vehicle, required home address and disabled save until pin confirmed", () => {
    vi.stubGlobal("window", { location: { pathname: "/drivers" } });
    const markup = renderToStaticMarkup(<App />);
    expect(markup).toContain("<h1>Drivers</h1>");
    for (const field of ['name="userId"', 'name="name"', 'name="homeAddress"', 'name="usualVehicleId"']) {
      expect(markup).toContain(field);
    }
    expect(markup).toContain("Suggest pin");
    expect(markup).toContain('data-testid="pin-picker-map"');
    expect(markup).toMatch(/<button type="submit" disabled="">Save driver<\/button>/);
  });

  it("renders the Pasajeros page at /passengers with every field, the shared pin picker and save disabled until the pin is confirmed", () => {
    vi.stubGlobal("window", { location: { pathname: "/passengers" } });
    const markup = renderToStaticMarkup(<App />);
    expect(markup).toContain("<h1>Passengers</h1>");
    for (const field of [
      'name="name"', 'name="homeAddress"', 'name="accessNotes"', 'name="companions"', 'name="frontSeat"', 'name="wheelchair"',
      'name="maxRideTimeMinutes"', 'name="pickupDurationMinutes"', 'name="dropoffDurationMinutes"', '<input maxLength="140" name="medicalAlert"',
    ]) expect(markup).toContain(field);
    for (const count of ["0", "1", "2"]) expect(markup).toContain(`<option value="${count}"`);
    expect(markup).not.toMatch(/<option value="3"/);
    expect(markup).toContain("Required vehicle features");
    expect(markup).toContain("Suggest pin");
    expect(markup).toContain('data-testid="pin-picker-map"');
    expect(markup).toMatch(/<button type="submit" disabled="">Save passenger<\/button>/);
    expect(markup).toContain('href="/passengers"');
    expect(markup).not.toMatch(/diagnos|gender|sex\b/i);
  });

  it("proposes 5 boarding and 5 alighting minutes that the Oficina can change for each Pasajero", () => {
    vi.stubGlobal("window", { location: { pathname: "/passengers" } });
    const markup = renderToStaticMarkup(<App />);
    for (const field of ["pickupDurationMinutes", "dropoffDurationMinutes"]) {
      expect(markup).toMatch(new RegExp(`<input type="number" min="1" step="1" required="" name="${field}" value="5"/>`));
    }
  });

  it("proposes a required Tiempo máximo a bordo of 60 minutes", () => {
    vi.stubGlobal("window", { location: { pathname: "/passengers" } });
    const markup = renderToStaticMarkup(<App />);
    expect(markup).toMatch(/<input type="number" min="1" step="1" required="" name="maxRideTimeMinutes" value="60"\/>/);
  });
});
