import { describe, expect, it } from "vitest";
import { TRASBORDO_WINDOW_MINUTES, validateRoute, type Stop, type Transfer } from "./index.js";

// Leg B of a Trasbordo at 08:00 for an entrada to a school at 08:40, with a 60-minute Tiempo máximo a bordo.
const passengers = [{ id: "p1", maxRideTimeMinutes: 60, dropoffDurationMinutes: 5 }];
const vehicle = { id: "v2", capacity: { seats: 4 } };
const legB = (fields: Partial<Transfer>): Transfer => ({
  id: "b", passengerId: "p1", direction: "entrada", targetTime: "08:40", lateToleranceMinutes: 0,
  trasbordo: { stop: "pickup", earliest: 8 * 60, latest: 8 * 60 + TRASBORDO_WINDOW_MINUTES }, ...fields,
});
const stops = (pickup: string, dropoff: string): Stop[] => [
  { id: "1", transferId: "b", type: "pickup", plannedTime: pickup },
  { id: "2", transferId: "b", type: "dropoff", plannedTime: dropoff },
];

describe("Trasbordo legs in the route validator", () => {
  // AC5 / Regla 2: the ride of leg B counts from the chain's first pickup (Subió in A), waiting at the point included.
  it("sums the whole chain from the Subió in leg A, waiting at the point included, against the Tiempo máximo a bordo", () => {
    // Leg B alone rides 08:02-08:35 (+5 service): 38 minutes. From the Subió in A at 07:30 it is 70 minutes.
    expect(validateRoute({ route: stops("08:02", "08:35"), passengers, vehicle, transfers: [legB({})] })).toEqual([]);
    expect(validateRoute({ route: stops("08:02", "08:35"), passengers, vehicle, transfers: [legB({ rideStartMinutes: 7 * 60 + 30 })] }))
      .toEqual([expect.objectContaining({ rule: "max_ride_time_exceeded", transferId: "b", details: { rideTimeMinutes: 70, maxRideTimeMinutes: 60 } })]);
    expect(validateRoute({ route: stops("08:02", "08:35"), passengers, vehicle, transfers: [legB({ rideStartMinutes: 7 * 60 + 40 })] })).toEqual([]);
  });

  // AC4: the leg's end at the Trasbordo point is held to the hard window [t, t + 5]; when that end carries the target
  // time, the window replaces it.
  it("holds the end of a leg at the Trasbordo point to [t, t + 5] and lets the window replace the target time there", () => {
    expect(validateRoute({ route: stops("08:05", "08:35"), passengers, vehicle, transfers: [legB({})] })).toEqual([]);
    expect(validateRoute({ route: stops("08:06", "08:35"), passengers, vehicle, transfers: [legB({})] })).toEqual([
      expect.objectContaining({
        rule: "trasbordo_window_broken", transferId: "b",
        details: { plannedMinutes: 486, earliestMinutes: 480, latestMinutes: 485, stop: "pickup" },
      }),
    ]);
    // Leg A of the same entrada ends at the point at 08:03, long before its target 08:40: only the window applies.
    const legA: Transfer = {
      id: "a", passengerId: "p1", direction: "entrada", targetTime: "08:40", trasbordo: { stop: "dropoff", earliest: 480, latest: 485 },
    };
    const route: Stop[] = [
      { id: "1", transferId: "a", type: "pickup", plannedTime: "07:40" },
      { id: "2", transferId: "a", type: "dropoff", plannedTime: "08:03" },
    ];
    expect(validateRoute({ route, passengers, vehicle, transfers: [legA] })).toEqual([]);
    expect(validateRoute({ route: [route[0], { ...route[1], plannedTime: "07:59" }], passengers, vehicle, transfers: [legA] }))
      .toEqual([expect.objectContaining({ rule: "trasbordo_window_broken", transferId: "a" })]);
  });
});
