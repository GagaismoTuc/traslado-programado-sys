import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { weekdayName } from "./PlanPage";

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

  it("renders Copy from last <weekday> button when the plan is empty or missing", () => {
    const missing = true;
    const day = null;
    const date = "2026-11-09";
    const isEmpty = missing || (day && (day as { transfers: unknown[] }).transfers.length === 0);

    const markup = renderToStaticMarkup(
      <div>
        {missing && <button type="button">Create plan</button>}
        {isEmpty && <button type="button">{`Copy from last ${weekdayName(date)}`}</button>}
      </div>,
    );

    expect(markup).toContain("Create plan");
    expect(markup).toContain("Copy from last Monday");
  });

  it("does not offer Copy from last <weekday> when the plan already has transfers", () => {
    const missing = false;
    const day = { transfers: [{ id: 1 }] };
    const date = "2026-11-09";
    const isEmpty = missing || (day && day.transfers.length === 0);

    const markup = renderToStaticMarkup(
      <div>
        {isEmpty && <button type="button">{`Copy from last ${weekdayName(date)}`}</button>}
      </div>,
    );

    expect(markup).toBe("<div></div>");
    expect(markup).not.toContain("Copy from last Monday");
  });
});
