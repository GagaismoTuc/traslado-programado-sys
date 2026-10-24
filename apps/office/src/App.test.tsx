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
    expect(new Set(imports)).toEqual(new Set(["react", "maplibre-gl", "maplibre-gl/dist/maplibre-gl.css"]));
    expect(pinPickerSource).not.toMatch(/destination/i);
    const markup = renderToStaticMarkup(<PinPicker value={{ lat: -26.8241, lng: -65.2036 }} onChange={() => undefined} suggestion={null} />);
    expect(markup).toContain("Pin: -26.824100, -65.203600");
    expect(MAP_STYLE_URL).toBe("https://tiles.openfreemap.org/styles/liberty");
  });
});
