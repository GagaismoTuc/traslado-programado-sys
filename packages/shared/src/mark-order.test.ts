import { describe, expect, it } from "vitest";
import { markOrder } from "./index";

describe("markOrder", () => {
  const order = markOrder<{ phoneTime: string; stored: number }>((item) => item.phoneTime, (a, b) => a.stored - b.stored);

  it("orders by phone time first and by arrival at the server only when phone times tie", () => {
    const early = { phoneTime: "2026-10-23T12:00:00.000Z", stored: 3 };
    const tiedFirst = { phoneTime: "2026-10-23T12:01:00.000Z", stored: 1 };
    const tiedLast = { phoneTime: "2026-10-23T09:01:00.000-03:00", stored: 2 };
    expect([tiedLast, early, tiedFirst].sort(order)).toEqual([early, tiedFirst, tiedLast]);
  });
});
