import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("driver placeholder screen", () => {
  it("renders the driver placeholder page", () => {
    expect(renderToStaticMarkup(<App />)).toContain("<h1>Driver</h1>");
  });
});
