import { describe, expect, it } from "vitest";
import {
  type ServerEpoch,
  validateRoute,
  parseTimeToMinutes,
  addCapacity,
  subtractCapacity,
  isCapacityExceeded,
  isRouteValid,
  type Route,
  type Passenger,
  type Vehicle,
  type Transfer,
  type CapacityVector,
  type Stop,
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

  it("R2 with epoch-millisecond numbers (Date.getTime())", () => {
    const t: Transfer = { id: "t", passengerId: "p" };
    const p0 = Date.parse("2026-10-23T08:00:00Z");
    const route: Stop[] = [
      { id: "a", transferId: "t", type: "pickup", plannedTime: p0 },
      { id: "b", transferId: "t", type: "dropoff", plannedTime: p0 + 30 * 60_000 },
    ];
    expect(validateRoute({ route, passengers: [{ id: "p", maxRideTimeMinutes: 45 }], vehicle: { id: "v", capacity: { seats: 4 } }, transfers: [t] })).toEqual([]);
  });

  it("parseTimeToMinutes parses Date, epoch milliseconds, epoch seconds, HH:mm, and relative minutes correctly", () => {
    const epochMs = Date.parse("2026-10-23T08:00:00Z");
    const epochSec = Math.floor(epochMs / 1000);
    const expectedMinutes = epochMs / 60000;

    expect(parseTimeToMinutes(new Date(epochMs))).toBe(expectedMinutes);
    expect(parseTimeToMinutes(epochMs)).toBe(expectedMinutes);
    expect(parseTimeToMinutes(String(epochMs))).toBe(expectedMinutes);
    expect(parseTimeToMinutes(epochSec)).toBe(expectedMinutes);
    expect(parseTimeToMinutes("08:30")).toBe(510);
    expect(parseTimeToMinutes("08:30:30")).toBe(510.5);
    expect(parseTimeToMinutes(45)).toBe(45);
    expect(parseTimeToMinutes(undefined)).toBeUndefined();
    expect(parseTimeToMinutes(null as unknown as undefined)).toBeUndefined();
  });

  // AC: capacity over the Vehículo's (an Acompañante takes a seat)
  it("accounts for companion taking a seat when validating vehicle capacity", () => {
    const vehicle: Vehicle = { id: "v1", capacity: { seats: 2 } };
    const p1: Passenger = { id: "p1", companions: 1 }; // takes 2 seats
    const p2: Passenger = { id: "p2", companions: 0 }; // takes 1 seat
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

  // Pasajeros Regla 4 and AC: the count replaces the yes/no flag; each Acompañante takes a seat.
  it("counts each Acompañante of a Pasajero as one more seat", () => {
    // @ts-expect-error the yes/no flag no longer exists: the number of Acompañantes is the only source of truth.
    const flagged: Passenger = { id: "p0", requiresCompanion: true };
    void flagged;
    const vehicle: Vehicle = { id: "v1", capacity: { seats: 3, front: 1 } };
    const p1: Passenger = { id: "p1", companions: 2 };
    const p2: Passenger = { id: "p2", companions: 0 };
    const transfers: Transfer[] = [{ id: "t1", passengerId: "p1" }, { id: "t2", passengerId: "p2" }];
    const stops = (order: string[]): Stop[] => order.map((key, index) => ({
      id: `s${index}`,
      transferId: key.slice(1),
      type: key[0] === "+" ? "pickup" : "dropoff",
      plannedTime: `08:${String(index * 5).padStart(2, "0")}`,
    }));

    const alone = validateRoute({ route: stops(["+t1", "-t1", "+t2", "-t2"]), passengers: [p1, p2], vehicle, transfers });
    expect(alone.filter((v) => v.rule === "capacity_exceeded")).toEqual([]);
    const together = validateRoute({ route: stops(["+t1", "+t2", "-t1", "-t2"]), passengers: [p1, p2], vehicle, transfers });
    expect(together.filter((v) => v.rule === "capacity_exceeded").map((v) => [v.passengerId, v.details?.currentLoad]))
      .toEqual([["p2", { seats: 4 }]]);
  });

  // Pasajeros AC: the per-Pasajero default can be overridden by each Traslado.
  it("lets a Traslado override the Pasajero's number of Acompañantes, for example one only on the entrada", () => {
    const vehicle: Vehicle = { id: "v1", capacity: { seats: 2, front: 1 } };
    const p1: Passenger = { id: "p1", companions: 0 };
    const p2: Passenger = { id: "p2", companions: 0 };
    const entrada: Transfer = { id: "t1", passengerId: "p1", direction: "entrada", companions: 1 };
    const salida: Transfer = { id: "t3", passengerId: "p1", direction: "salida" };
    const other: Transfer = { id: "t2", passengerId: "p2" };
    const sharedRide = (transferId: string): Stop[] => [
      { id: "s1", transferId, type: "pickup", plannedTime: "08:00" },
      { id: "s2", transferId: "t2", type: "pickup", plannedTime: "08:05" },
      { id: "s3", transferId, type: "dropoff", plannedTime: "08:10" },
      { id: "s4", transferId: "t2", type: "dropoff", plannedTime: "08:15" },
    ];
    const capacity = (transfer: Transfer) =>
      validateRoute({ route: sharedRide(transfer.id), passengers: [p1, p2], vehicle, transfers: [transfer, other] })
        .filter((v) => v.rule === "capacity_exceeded")
        .map((v) => v.details?.currentLoad);

    expect(capacity(entrada)).toEqual([{ seats: 3 }]);
    expect(capacity(salida)).toEqual([]);
    expect(capacity({ ...entrada, companions: 0 })).toEqual([]);
  });

  // Pasajeros Regla 5: the Asiento delantero requirement consumes seats: 1 and front: 1.
  it("counts a Pasajero who needs the Asiento delantero as seats: 1 and front: 1", () => {
    const vehicle: Vehicle = { id: "v1", capacity: { seats: 5, front: 1 } };
    const passengers: Passenger[] = [{ id: "p1", frontSeat: true }, { id: "p2", frontSeat: true }, { id: "p3", frontSeat: false }];
    const capacity = (second: string) => {
      const route: Stop[] = [
        { id: "s1", transferId: "t1", type: "pickup", plannedTime: "08:00" },
        { id: "s2", transferId: second, type: "pickup", plannedTime: "08:05" },
        { id: "s3", transferId: "t1", type: "dropoff", plannedTime: "08:10" },
        { id: "s4", transferId: second, type: "dropoff", plannedTime: "08:15" },
      ];
      const transfers: Transfer[] = [{ id: "t1", passengerId: "p1" }, { id: second, passengerId: second === "t2" ? "p2" : "p3" }];
      return validateRoute({ route, passengers, vehicle, transfers })
        .filter((v) => v.rule === "capacity_exceeded")
        .map((v) => v.details?.currentLoad);
    };

    expect(capacity("t3")).toEqual([]);
    expect(capacity("t2")).toEqual([{ seats: 2, front: 2 }]);
  });

  // Regla 3: An empty violation list is the only "valid" result.
  it("returns an empty violation list as the only valid result when all rules pass", () => {
    const passenger: Passenger = { id: "p1", maxRideTimeMinutes: 45, companions: 0, requiredFeatures: ["rampa_silla_de_ruedas"] };
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
