import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("office placeholder screen", () => {
  it("renders the office placeholder page", () => {
    expect(renderToStaticMarkup(<App />)).toContain("<h1>Office</h1>");
  });
});
