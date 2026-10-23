import { describe, expect, it } from "vitest";
import {
  type ServerEpoch,
  validateRoute,
  addCapacity,
  subtractCapacity,
  isCapacityExceeded,
  isRouteValid,
  type Route,
  type Passenger,
  type Vehicle,
  type Transfer,
  type CapacityVector,
} from "./index.js";

describe("Route validator and capacity vector", () => {
  // PRESERVE
  it("preserves ServerEpoch export", () => {
    const epoch: ServerEpoch = "epoch-test";
    expect(epoch).toBe("epoch-test");
  });

  // AC: Capacity is a vector (seats now) shared by the validator and the planner
  it("computes capacity vector operations and detects capacity exceeded", () => {
    const a: CapacityVector = { seats: 2, wheelchairs: 1 };
    const b: CapacityVector = { seats: 3, wheelchairs: 0 };
    const combined = addCapacity(a, b);
    expect(combined.seats).toBe(5);
    expect(combined.wheelchairs).toBe(1);

    const reduced = subtractCapacity(combined, { seats: 2, wheelchairs: 1 });
    expect(reduced.seats).toBe(3);
    expect(reduced.wheelchairs).toBe(0);

    const limit: CapacityVector = { seats: 4, wheelchairs: 1 };
    expect(isCapacityExceeded(combined, limit)).toBe(true);
    expect(isCapacityExceeded(reduced, limit)).toBe(false);
  });

  // Regla 1: The validator uses the real Tiempo máximo a bordo, never the engine's reduced value.
  it("uses real Tiempo maximo a bordo rather than reduced engine value to detect violations", () => {
    const passenger: Passenger = { id: "p1", maxRideTimeMinutes: 45 };
    const vehicle: Vehicle = { id: "v1", capacity: { seats: 4 } };
    const transfer: Transfer = { id: "t1", passengerId: "p1", direction: "inbound" };

    const routeUnderRealLimit: Route = {
      stops: [
        { id: "s1", transferId: "t1", type: "pickup", plannedTime: "2026-10-23T08:00:00Z", serviceDurationMinutes: 2 },
        { id: "s2", transferId: "t1", type: "dropoff", plannedTime: "2026-10-23T08:38:00Z", serviceDurationMinutes: 2 },
      ],
    };
    expect(validateRoute({ route: routeUnderRealLimit, legDurations: [38], passengers: [passenger], vehicle, transfers: [transfer] })).toEqual([]);

    const routeOverRealLimit: Route = {
      stops: [
        { id: "s1", transferId: "t1", type: "pickup", plannedTime: "2026-10-23T08:00:00Z", serviceDurationMinutes: 2 },
        { id: "s2", transferId: "t1", type: "dropoff", plannedTime: "2026-10-23T08:48:00Z", serviceDurationMinutes: 3 },
      ],
    };
    const failResult = validateRoute({ route: routeOverRealLimit, legDurations: [48], passengers: [passenger], vehicle, transfers: [transfer] });
    expect(failResult[0]?.rule).toBe("max_ride_time_exceeded");
    expect(failResult[0]?.passengerId).toBe("p1");
  });

  // Regla 2: Ride time counts from the start of the pickup service to the end of the drop-off service.
  it("calculates ride time from start of pickup service to end of drop-off service", () => {
    const passenger: Passenger = { id: "p1", maxRideTimeMinutes: 30 };
    const vehicle: Vehicle = { id: "v1", capacity: { seats: 4 } };
    const transfer: Transfer = { id: "t1", passengerId: "p1", direction: "inbound" };
    const route: Route = {
      stops: [
        { id: "s1", transferId: "t1", type: "pickup", plannedTime: "2026-10-23T08:00:00Z", serviceDurationMinutes: 3 },
        { id: "s2", transferId: "t1", type: "dropoff", plannedTime: "2026-10-23T08:25:00Z", serviceDurationMinutes: 6 },
      ],
    };
    const violations = validateRoute({ route, legDurations: [25], passengers: [passenger], vehicle, transfers: [transfer] });
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("max_ride_time_exceeded");
    expect(violations[0].details?.rideTimeMinutes).toBe(31);
  });

  // AC: capacity over the Vehículo's (an Acompañante takes a seat)
  it("accounts for companion taking a seat when validating vehicle capacity", () => {
    const vehicle: Vehicle = { id: "v1", capacity: { seats: 2 } };
    const p1: Passenger = { id: "p1", requiresCompanion: true }; // takes 2 seats
    const p2: Passenger = { id: "p2", requiresCompanion: false }; // takes 1 seat
    const t1: Transfer = { id: "t1", passengerId: "p1" };
    const t2: Transfer = { id: "t2", passengerId: "p2" };

    const overflowRoute: Route = {
      stops: [
        { id: "s1", transferId: "t1", type: "pickup", plannedTime: "2026-10-23T08:00:00Z" },
        { id: "s2", transferId: "t2", type: "pickup", plannedTime: "2026-10-23T08:10:00Z" },
        { id: "s3", transferId: "t1", type: "dropoff", plannedTime: "2026-10-23T08:20:00Z" },
        { id: "s4", transferId: "t2", type: "dropoff", plannedTime: "2026-10-23T08:30:00Z" },
      ],
    };
    const violations = validateRoute({ route: overflowRoute, passengers: [p1, p2], vehicle, transfers: [t1, t2] });
    expect(violations.some((v) => v.rule === "capacity_exceeded" && v.passengerId === "p2")).toBe(true);

    const validRoute: Route = {
      stops: [
        { id: "s1", transferId: "t1", type: "pickup", plannedTime: "2026-10-23T08:00:00Z" },
        { id: "s3", transferId: "t1", type: "dropoff", plannedTime: "2026-10-23T08:15:00Z" },
        { id: "s2", transferId: "t2", type: "pickup", plannedTime: "2026-10-23T08:20:00Z" },
        { id: "s4", transferId: "t2", type: "dropoff", plannedTime: "2026-10-23T08:30:00Z" },
      ],
    };
    expect(validateRoute({ route: validRoute, passengers: [p1, p2], vehicle, transfers: [t1, t2] })).toHaveLength(0);
  });

  // AC: a required Adaptación the Vehículo lacks
  it("detects when vehicle lacks a required adaptation for a passenger", () => {
    const passenger: Passenger = { id: "p1", requiredFeatures: ["rampa_silla_de_ruedas"] };
    const vehicleLacking: Vehicle = { id: "v1", capacity: { seats: 4 }, features: [] };
    const transfer: Transfer = { id: "t1", passengerId: "p1" };
    const route: Route = {
      stops: [
        { id: "s1", transferId: "t1", type: "pickup", plannedTime: "2026-10-23T08:00:00Z" },
        { id: "s2", transferId: "t1", type: "dropoff", plannedTime: "2026-10-23T08:20:00Z" },
      ],
    };

    const violations = validateRoute({ route, passengers: [passenger], vehicle: vehicleLacking, transfers: [transfer] });
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("missing_adaptation");

    const vehicleWithFeature: Vehicle = { id: "v2", capacity: { seats: 4 }, features: ["rampa_silla_de_ruedas"] };
    expect(validateRoute({ route, passengers: [passenger], vehicle: vehicleWithFeature, transfers: [transfer] })).toHaveLength(0);
  });

  // AC: a target time window broken
  it("flags violation when planned arrival breaks target time window", () => {
    const passenger: Passenger = { id: "p1" };
    const vehicle: Vehicle = { id: "v1", capacity: { seats: 4 } };
    const transfer: Transfer = { id: "t1", passengerId: "p1", direction: "inbound", targetTime: "2026-10-23T08:30:00Z" };

    const lateRoute: Route = {
      stops: [
        { id: "s1", transferId: "t1", type: "pickup", plannedTime: "2026-10-23T08:00:00Z" },
        { id: "s2", transferId: "t1", type: "dropoff", plannedTime: "2026-10-23T08:35:00Z" },
      ],
    };
    expect(validateRoute({ route: lateRoute, passengers: [passenger], vehicle, transfers: [transfer] }).some((v) => v.rule === "target_time_window_broken")).toBe(true);

    const onTimeRoute: Route = {
      stops: [
        { id: "s1", transferId: "t1", type: "pickup", plannedTime: "2026-10-23T08:00:00Z" },
        { id: "s2", transferId: "t1", type: "dropoff", plannedTime: "2026-10-23T08:25:00Z" },
      ],
    };
    expect(validateRoute({ route: onTimeRoute, passengers: [passenger], vehicle, transfers: [transfer] })).toHaveLength(0);
  });

  // AC: a Traslado of the Recorrido left unserved
  it("detects unserved transfer in the route", () => {
    const p1: Passenger = { id: "p1" };
    const p2: Passenger = { id: "p2" };
    const vehicle: Vehicle = { id: "v1", capacity: { seats: 4 } };
    const t1: Transfer = { id: "t1", passengerId: "p1" };
    const t2: Transfer = { id: "t2", passengerId: "p2" };

    const partialRoute: Route = {
      stops: [
        { id: "s1", transferId: "t1", type: "pickup", plannedTime: "2026-10-23T08:00:00Z" },
        { id: "s2", transferId: "t1", type: "dropoff", plannedTime: "2026-10-23T08:20:00Z" },
      ],
    };
    expect(validateRoute({ route: partialRoute, passengers: [p1, p2], vehicle, transfers: [t1, t2] }).some((v) => v.rule === "unserved_transfer" && v.passengerId === "p2")).toBe(true);

    const fullRoute: Route = {
      stops: [
        { id: "s1", transferId: "t1", type: "pickup", plannedTime: "2026-10-23T08:00:00Z" },
        { id: "s3", transferId: "t2", type: "pickup", plannedTime: "2026-10-23T08:10:00Z" },
        { id: "s2", transferId: "t1", type: "dropoff", plannedTime: "2026-10-23T08:20:00Z" },
        { id: "s4", transferId: "t2", type: "dropoff", plannedTime: "2026-10-23T08:30:00Z" },
      ],
    };
    expect(validateRoute({ route: fullRoute, passengers: [p1, p2], vehicle, transfers: [t1, t2] })).toHaveLength(0);
  });

  // AC: drop-off before pickup
  it("flags violation when drop-off is scheduled before pickup", () => {
    const passenger: Passenger = { id: "p1" };
    const vehicle: Vehicle = { id: "v1", capacity: { seats: 4 } };
    const transfer: Transfer = { id: "t1", passengerId: "p1" };

    const invertedRoute: Route = {
      stops: [
        { id: "s2", transferId: "t1", type: "dropoff", plannedTime: "2026-10-23T08:00:00Z" },
        { id: "s1", transferId: "t1", type: "pickup", plannedTime: "2026-10-23T08:20:00Z" },
      ],
    };
    expect(validateRoute({ route: invertedRoute, passengers: [passenger], vehicle, transfers: [transfer] }).some((v) => v.rule === "dropoff_before_pickup")).toBe(true);

    const normalRoute: Route = {
      stops: [
        { id: "s1", transferId: "t1", type: "pickup", plannedTime: "2026-10-23T08:00:00Z" },
        { id: "s2", transferId: "t1", type: "dropoff", plannedTime: "2026-10-23T08:20:00Z" },
      ],
    };
    expect(validateRoute({ route: normalRoute, passengers: [passenger], vehicle, transfers: [transfer] })).toHaveLength(0);
  });

  // Regla 3: An empty violation list is the only "valid" result.
  it("returns an empty violation list as the only valid result when all rules pass", () => {
    const passenger: Passenger = { id: "p1", maxRideTimeMinutes: 45, requiresCompanion: false, requiredFeatures: ["rampa_silla_de_ruedas"] };
    const vehicle: Vehicle = { id: "v1", capacity: { seats: 4 }, features: ["rampa_silla_de_ruedas"] };
    const transfer: Transfer = { id: "t1", passengerId: "p1", direction: "inbound", targetTime: "2026-10-23T08:30:00Z" };
    const validRoute: Route = {
      stops: [
        { id: "s1", transferId: "t1", type: "pickup", plannedTime: "2026-10-23T08:05:00Z", serviceDurationMinutes: 2 },
        { id: "s2", transferId: "t1", type: "dropoff", plannedTime: "2026-10-23T08:25:00Z", serviceDurationMinutes: 2 },
      ],
    };

    const violations = validateRoute({ route: validRoute, legDurations: [20], passengers: [passenger], vehicle, transfers: [transfer] });
    expect(violations).toEqual([]);
    expect(isRouteValid(violations)).toBe(true);
  });
});
