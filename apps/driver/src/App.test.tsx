import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./App";
import appSource from "./App.tsx?raw";

describe("driver sign-in", () => {
  it("renders the driver sign-in page", () => {
    const markup = renderToStaticMarkup(<App />);
    expect(markup).toContain("<h1>Driver sign-in</h1>");
    expect(markup).toContain('name="username"');
    expect(markup).toContain('type="password"');
  });

  it("does not show Vencimientos to a Chofer", () => {
    const markup = renderToStaticMarkup(<App />);
    expect(markup).not.toMatch(/vencimiento|expir|documents/i);
    expect(appSource).not.toMatch(/\/expiries|\/documents/);
  });
});
