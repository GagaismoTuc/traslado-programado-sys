import { expect, it } from "vitest";
import { boardedWindow, type PlanTransfer } from "../src/planner.js";

const leg: PlanTransfer = {
  id: 91, direction: "entrada", targetMinutes: 510,
  pickup: [-65.2, -26.8], dropoff: [-65.21, -26.81],
  seats: 1, frontSeat: false, requiredFeatureIds: [], maxRideMinutes: 90,
  pickupMinutes: 1, dropoffMinutes: 1,
  trasbordo: { stop: "dropoff", minutes: 480 }, boardedMinutes: 470,
};
const settings = { rideTimeBufferMinutes: 0, speedFactors: [], earlyToleranceMinutes: 15 };

it("keeps the fixed handover window for leg A after boarding", () => {
  expect(boardedWindow(leg, settings)).toEqual([480 * 60, 485 * 60]);
});

it("ends leg A's handover window by the ride limit counted from the original Subió", () => {
  // Subió 07:00, R' = 63 min, 1 min of drop-off: the drop-off starts by 08:02, inside [08:00, 08:05]; with R' = 60, by 07:59, too early.
  expect(boardedWindow({ ...leg, boardedMinutes: 420, maxRideMinutes: 63 }, settings)).toEqual([480 * 60, 482 * 60]);
  expect(boardedWindow({ ...leg, boardedMinutes: 420, maxRideMinutes: 60 }, settings)).toBeNull();
});
