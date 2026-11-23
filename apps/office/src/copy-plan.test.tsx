import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlanPage, weekdayName } from "./PlanPage";

describe("Copy the last same weekday", () => {
  it("computes the weekday name from a YYYY-MM-DD date", () => {
    expect(weekdayName("2026-11-09")).toBe("Monday");
    expect(weekdayName("2026-11-10")).toBe("Tuesday");
    expect(weekdayName("2026-11-11")).toBe("Wednesday");
    expect(weekdayName("2026-11-12")).toBe("Thursday");
    expect(weekdayName("2026-11-13")).toBe("Friday");
    expect(weekdayName("2026-11-14")).toBe("Saturday");
    expect(weekdayName("2026-11-15")).toBe("Sunday");
  });

  it("formats the action label as Copy from last <weekday>", () => {
    expect(`Copy from last ${weekdayName("2026-11-09")}`).toBe("Copy from last Monday");
    expect(`Copy from last ${weekdayName("2026-11-10")}`).toBe("Copy from last Tuesday");
    expect(`Copy from last ${weekdayName("2026-11-13")}`).toBe("Copy from last Friday");
  });

  it("renders Copy from last <weekday> button when the plan is missing (inexistente)", () => {
    const markup = renderToStaticMarkup(
      <PlanPage initialDate="2026-11-09" initialView={{ date: "2026-11-09", day: null, missing: true }} />,
    );

    expect(markup).toContain("Create plan");
    expect(markup).toContain("Copy from last Monday");
  });

  it("renders Copy from last <weekday> button when the plan is empty (0 transfers)", () => {
    const emptyDay = {
      plan: { id: 1, date: "2026-11-09", timeZone: "America/Argentina/Tucuman" },
      transfers: [],
      routes: [],
      unpublishedTransferIds: [],
      km: 0,
    };
    const markup = renderToStaticMarkup(
      <PlanPage initialDate="2026-11-09" initialView={{ date: "2026-11-09", day: emptyDay as any, missing: false }} />,
    );

    expect(markup).not.toContain("Create plan");
    expect(markup).toContain("Copy from last Monday");
  });

  it("does not offer Copy from last <weekday> when the plan already has transfers", () => {
    const dayWithTransfers = {
      plan: { id: 1, date: "2026-11-09", timeZone: "America/Argentina/Tucuman" },
      unpublishedTransferIds: [],
      transfers: [
        {
          id: 1,
          passengerId: 10,
          passengerName: "Pasajero Sintético",
          direction: "entrada",
          destinationId: 2,
          destinationName: "Escuela",
          originDestinationId: null,
          originDestinationName: null,
          targetTime: "08:00",
          exitTime: null,
          companions: 0,
          status: "planificado",
          routeId: null,
          chainedFromTransferId: null,
          chainedToTransferId: null,
          trasbordo: null,
        },
      ],
      routes: [],
      km: 0,
    };

    const markup = renderToStaticMarkup(
      <PlanPage initialDate="2026-11-09" initialView={{ date: "2026-11-09", day: dayWithTransfers as any, missing: false }} />,
    );

    expect(markup).not.toContain("Copy from last Monday");
  });
});
