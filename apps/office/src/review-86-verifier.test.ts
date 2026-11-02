import { expect, it } from "vitest";
import { trasbordoMode } from "./TrasbordoPanel";

it("offers another handover if the receiving vehicle breaks down", () => {
  expect(trasbordoMode({
    id: 18, status: "subio",
    trasbordo: { stop: "pickup", lat: -26.9, lng: -65.3, time: "08:00" },
  })).toBe("handover");
});
