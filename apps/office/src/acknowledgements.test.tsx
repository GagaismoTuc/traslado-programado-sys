import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MissingAcknowledgements } from "./PlanPage";

// Synthetic data only.
describe("Confirmación de versión in the Plan diario", () => {
  it("lists the Choferes who have not acknowledged the latest version, with the last one they saw", () => {
    const markup = renderToStaticMarkup(<MissingAcknowledgements missing={[
      { routeId: 1, version: 1, driverName: "Chofer Sintético", startTime: "07:00", endTime: "09:00", acknowledgedVersion: null },
      { routeId: 2, version: 3, driverName: "Chofera Sintética", startTime: "12:00", endTime: "14:00", acknowledgedVersion: 2 },
    ]} />);
    expect(markup).toBe(
      "<section><h2>Not acknowledged by the Chofer</h2><ul>"
      + "<li>Chofer Sintético 07:00-09:00: version 1, no version acknowledged yet</li>"
      + "<li>Chofera Sintética 12:00-14:00: version 3, last acknowledged version 2</li></ul></section>",
    );
    expect(renderToStaticMarkup(<MissingAcknowledgements missing={[]} />))
      .toContain("<p>Every Chofer acknowledged the latest version of their Recorrido.</p>");
  });
});
