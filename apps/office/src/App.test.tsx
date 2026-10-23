import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

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
});
