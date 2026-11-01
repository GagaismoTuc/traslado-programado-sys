import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { canForce, CascadeWarnings, DaySummaryView, UnpublishedTransfers, ViolationList, type PassengerViolations } from "./PlanPage";

// Synthetic data only.
const routes = [
  { id: 1, driverName: "Chofer Sintético", startTime: "07:00", endTime: "09:00" },
  { id: 2, driverName: "Chofer Sintético", startTime: "09:10", endTime: "10:00" },
];
const tooLong: PassengerViolations = {
  passengerId: 7,
  passengerName: "Pasajero Sintético",
  violations: [{ rule: "max_ride_time_exceeded", transferId: 3, message: "Ride time for passenger 7 (13 min) exceeds maximum (5 min)" }],
};
const unserved: PassengerViolations = {
  passengerId: 8,
  passengerName: "Pasajera Sintética",
  violations: [{ rule: "unserved_transfer", transferId: 4, message: "Transfer 4 is left unserved in route" }],
};
const transfer = (id: number, targetTime: string, status = "planificado") => ({
  id, passengerId: 7, passengerName: "Pasajero Sintético", direction: "entrada" as const, destinationName: "Escuela Sintética",
  originDestinationName: null, targetTime, exitTime: null, companions: 0, status, routeId: null,
});

describe("Plan diario publication", () => {
  it("shows the validator's violations per Pasajero and offers forcing only without a Traslado unserved", () => {
    const markup = renderToStaticMarkup(<ViolationList violations={[tooLong, unserved]} />);
    expect(markup).toBe(
      "<ul><li><strong>Pasajero Sintético</strong><ul><li>Ride time for passenger 7 (13 min) exceeds maximum (5 min)</li></ul></li>"
      + "<li><strong>Pasajera Sintética</strong><ul><li>Transfer 4 is left unserved in route</li></ul></li></ul>",
    );
    expect(canForce([tooLong])).toBe(true);
    expect(canForce([tooLong, unserved])).toBe(false);
  });

  it("lists the Traslados not Cancelado por Ausencia without a published Recorrido", () => {
    const day = { transfers: [transfer(1, "08:00"), transfer(2, "09:00"), transfer(3, "10:00", "cancelado_ausencia")], unpublishedTransferIds: [2] };
    const markup = renderToStaticMarkup(<UnpublishedTransfers day={day} />);
    expect(markup).toBe(
      "<section><h2>Without a published Recorrido</h2><ul><li>09:00 Pasajero Sintético: entrada, home → Escuela Sintética</li></ul></section>",
    );
    expect(renderToStaticMarkup(<UnpublishedTransfers day={{ ...day, unpublishedTransferIds: [] }} />))
      .toContain("<p>Every Traslado has a published Recorrido.</p>");
  });

  it("summarizes the publication of the whole Plan diario with the Recorridos that failed the validator", () => {
    const markup = renderToStaticMarkup(<DaySummaryView routes={routes} summary={{
      published: [{ routeId: 1, version: 2 }],
      unchanged: [],
      failed: [{ routeId: 2, error: "The Recorrido breaks limits: fix it or publish it with a reason", violations: [tooLong] }],
      cascade: [],
    }} />);
    expect(markup).toContain("<p>Published: 1. Unchanged: 0. Not published: 1.</p>");
    expect(markup).toContain("<li>Chofer Sintético 07:00-09:00: version 2</li>");
    expect(markup).toContain("<strong>Chofer Sintético 09:10-10:00</strong>: The Recorrido breaks limits: fix it or publish it with a reason");
    expect(markup).toContain("<li>Ride time for passenger 7 (13 min) exceeds maximum (5 min)</li>");
  });

  it("warns the Oficina about the Chofer's chained next Recorrido after it is revalidated", () => {
    const markup = renderToStaticMarkup(<CascadeWarnings routes={routes} cascade={[
      { routeId: 2, version: 1, fromRouteId: 1, ok: false, problem: "The Chofer reaches the first Parada at 08:11, after its planned 08:08" },
    ]} />);
    expect(markup).toBe(
      "<ul role=\"alert\"><li>Check Chofer Sintético 09:10-10:00 (version 1): The Chofer reaches the first Parada at 08:11, after its planned 08:08."
      + " It was not republished.</li></ul>",
    );
    expect(renderToStaticMarkup(<CascadeWarnings routes={routes} cascade={[]} />)).toBe("");
  });
});
