export type ServerEpoch = string;

export interface CapacityVector {
  seats: number;
  [dimension: string]: number;
}

export function createCapacityVector(seats: number, extra?: Record<string, number>): CapacityVector {
  return { seats, ...extra };
}

export function addCapacity(a: CapacityVector, b: CapacityVector): CapacityVector {
  const result: CapacityVector = { seats: (a.seats ?? 0) + (b.seats ?? 0) };
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key !== "seats") result[key] = (a[key] ?? 0) + (b[key] ?? 0);
  }
  return result;
}

export function subtractCapacity(a: CapacityVector, b: CapacityVector): CapacityVector {
  const result: CapacityVector = { seats: Math.max(0, (a.seats ?? 0) - (b.seats ?? 0)) };
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key !== "seats") result[key] = Math.max(0, (a[key] ?? 0) - (b[key] ?? 0));
  }
  return result;
}

export function isCapacityExceeded(current: CapacityVector, limit: CapacityVector): boolean {
  if ((current.seats ?? 0) > (limit.seats ?? 0)) return true;
  for (const key of Object.keys(current)) {
    if (key !== "seats" && (current[key] ?? 0) > (limit[key] ?? 0)) return true;
  }
  return false;
}

export interface Passenger {
  id: string;
  name?: string;
  maxRideTimeMinutes?: number;
  tiempoMaximoABordoMinutos?: number;
  requiresCompanion?: boolean;
  requiereAcompanante?: boolean;
  requiredFeatures?: string[];
  adaptacionesRequeridas?: string[];
  pickupDurationMinutes?: number;
  dropoffDurationMinutes?: number;
  customCapacity?: CapacityVector;
}
export type Pasajero = Passenger;

export interface Vehicle {
  id: string;
  plate?: string;
  capacity: CapacityVector;
  features?: string[];
  adaptaciones?: string[];
}
export type Vehiculo = Vehicle;

export type TransferDirection = "inbound" | "outbound" | "entrada" | "salida";

export interface TargetTimeWindow {
  earliest?: Date | string | number;
  latest?: Date | string | number;
  target?: Date | string | number;
}

export interface Transfer {
  id: string;
  passengerId: string;
  direction?: TransferDirection;
  sentido?: TransferDirection;
  targetTime?: Date | string | number;
  horaObjetivo?: Date | string | number;
  targetWindow?: TargetTimeWindow;
  earlyToleranceMinutes?: number;
  lateToleranceMinutes?: number;
}
export type Traslado = Transfer;

export type StopType = "pickup" | "dropoff" | "subio" | "entregado" | "subida" | "bajada";

export interface Stop {
  id: string;
  transferId: string;
  passengerId?: string;
  type: StopType;
  plannedTime: Date | string | number;
  horaPlanificada?: Date | string | number;
  serviceDurationMinutes?: number;
}
export type Parada = Stop;

export interface Route {
  id?: string;
  vehicleId?: string;
  stops: Stop[];
  paradas?: Stop[];
}
export type Recorrido = Route;

export interface LegDuration {
  fromStopId?: string;
  toStopId?: string;
  durationMinutes: number;
}

export type RouteRuleViolationType =
  | "max_ride_time_exceeded"
  | "capacity_exceeded"
  | "missing_adaptation"
  | "target_time_window_broken"
  | "unserved_transfer"
  | "dropoff_before_pickup";

export interface RouteViolation {
  rule: RouteRuleViolationType;
  passengerId: string;
  transferId?: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ValidateRouteOptions {
  defaultEarlyToleranceMinutes?: number; // default: 15 (inferido)
  defaultLateToleranceMinutes?: number;  // default: 0 (inferido)
  defaultServiceDurationMinutes?: number;
}

export interface ValidateRouteInput {
  route: Route | Stop[];
  legDurations?: number[] | LegDuration[];
  passengers: Passenger[];
  vehicle: Vehicle;
  transfers: Transfer[];
  options?: ValidateRouteOptions;
}

export function isPickup(type: StopType): boolean {
  return type === "pickup" || type === "subio" || type === "subida";
}

export function isDropoff(type: StopType): boolean {
  return type === "dropoff" || type === "entregado" || type === "bajada";
}

export function parseTimeToMinutes(value: Date | string | number | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) return value.getTime() / 60000;
  if (typeof value === "number") {
    if (value > 10_000_000_000_000) return value / 60000;
    if (value > 10_000_000_00) return value / 60;
    return value;
  }
  if (typeof value === "string") {
    const timeMatch = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
    if (timeMatch) {
      const h = parseInt(timeMatch[1], 10);
      const m = parseInt(timeMatch[2], 10);
      const s = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0;
      return h * 60 + m + s / 60;
    }
    const parsed = new Date(value);
    if (!isNaN(parsed.getTime())) return parsed.getTime() / 60000;
    const num = Number(value);
    if (!isNaN(num)) return num;
  }
  return undefined;
}

export function validateRoute(
  routeOrInput: Route | Stop[] | ValidateRouteInput,
  legDurationsArg?: number[] | LegDuration[],
  passengersArg?: Passenger[],
  vehicleArg?: Vehicle,
  transfersArg?: Transfer[],
  optionsArg?: ValidateRouteOptions,
): RouteViolation[] {
  let routeInput: Route | Stop[];
  let legDurations: number[] | LegDuration[] | undefined = legDurationsArg;
  let passengers: Passenger[] = passengersArg ?? [];
  let vehicle: Vehicle = vehicleArg!;
  let transfers: Transfer[] = transfersArg ?? [];
  let options: ValidateRouteOptions = optionsArg ?? {};

  if (typeof routeOrInput === "object" && routeOrInput !== null && "vehicle" in routeOrInput && "passengers" in routeOrInput) {
    const input = routeOrInput as ValidateRouteInput;
    routeInput = input.route;
    legDurations = input.legDurations ?? legDurations;
    passengers = input.passengers;
    vehicle = input.vehicle;
    transfers = input.transfers;
    options = input.options ?? options;
  } else {
    routeInput = routeOrInput as Route | Stop[];
  }

  const stops: Stop[] = Array.isArray(routeInput) ? routeInput : (routeInput.stops ?? routeInput.paradas ?? []);
  const violations: RouteViolation[] = [];
  const defaultEarlyTol = options.defaultEarlyToleranceMinutes ?? 15;
  const defaultLateTol = options.defaultLateToleranceMinutes ?? 0;
  const defaultServiceDur = options.defaultServiceDurationMinutes ?? 0;

  const passengerMap = new Map<string, Passenger>(passengers.map((p) => [p.id, p]));
  const transferMap = new Map<string, Transfer>();
  for (const t of transfers) {
    transferMap.set(t.id, t);
    if (!passengerMap.has(t.passengerId)) passengerMap.set(t.passengerId, { id: t.passengerId });
  }

  // 1. Vehicle feature / adaptation check
  const vehicleFeatures = new Set<string>(vehicle?.features ?? vehicle?.adaptaciones ?? []);
  for (const passenger of passengers) {
    const required = passenger.requiredFeatures ?? passenger.adaptacionesRequeridas ?? [];
    for (const feat of required) {
      if (!vehicleFeatures.has(feat)) {
        violations.push({
          rule: "missing_adaptation",
          passengerId: passenger.id,
          message: `Vehicle lacks required adaptation '${feat}' for passenger ${passenger.id}`,
          details: { missingFeature: feat, vehicleFeatures: Array.from(vehicleFeatures) },
        });
      }
    }
  }

  // 2. Unserved transfer check
  for (const transfer of transfers) {
    const hasPickup = stops.some((s) => s.transferId === transfer.id && isPickup(s.type));
    const hasDropoff = stops.some((s) => s.transferId === transfer.id && isDropoff(s.type));
    if (!hasPickup || !hasDropoff) {
      violations.push({
        rule: "unserved_transfer",
        passengerId: transfer.passengerId,
        transferId: transfer.id,
        message: `Transfer ${transfer.id} is left unserved in route`,
        details: { hasPickup, hasDropoff },
      });
    }
  }

  // 3. Drop-off before pickup check
  for (const transfer of transfers) {
    const pickupIdx = stops.findIndex((s) => s.transferId === transfer.id && isPickup(s.type));
    const dropoffIdx = stops.findIndex((s) => s.transferId === transfer.id && isDropoff(s.type));
    if (pickupIdx !== -1 && dropoffIdx !== -1) {
      if (dropoffIdx < pickupIdx) {
        violations.push({
          rule: "dropoff_before_pickup",
          passengerId: transfer.passengerId,
          transferId: transfer.id,
          message: `Drop-off before pickup for transfer ${transfer.id}`,
          details: { pickupIndex: pickupIdx, dropoffIndex: dropoffIdx },
        });
      } else {
        const pMins = parseTimeToMinutes(stops[pickupIdx].plannedTime ?? stops[pickupIdx].horaPlanificada);
        const dMins = parseTimeToMinutes(stops[dropoffIdx].plannedTime ?? stops[dropoffIdx].horaPlanificada);
        if (pMins !== undefined && dMins !== undefined && dMins < pMins) {
          violations.push({
            rule: "dropoff_before_pickup",
            passengerId: transfer.passengerId,
            transferId: transfer.id,
            message: `Drop-off time is before pickup time for transfer ${transfer.id}`,
            details: { pickupMinutes: pMins, dropoffMinutes: dMins },
          });
        }
      }
    }
  }

  // 4. Vehicle capacity check (Acompañante takes a seat)
  let currentLoad: CapacityVector = { seats: 0 };
  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i];
    const transfer = transferMap.get(stop.transferId);
    const passengerId = stop.passengerId ?? transfer?.passengerId;
    const passenger = passengerId ? passengerMap.get(passengerId) : undefined;
    const hasCompanion = passenger?.requiresCompanion ?? passenger?.requiereAcompanante ?? false;
    const seatDemand = passenger?.customCapacity?.seats ?? (hasCompanion ? 2 : 1);
    const delta: CapacityVector = passenger?.customCapacity ?? { seats: seatDemand };

    if (isPickup(stop.type)) {
      currentLoad = addCapacity(currentLoad, delta);
      if (vehicle?.capacity && isCapacityExceeded(currentLoad, vehicle.capacity)) {
        violations.push({
          rule: "capacity_exceeded",
          passengerId: passengerId ?? "unknown",
          transferId: stop.transferId,
          message: `Vehicle capacity exceeded at stop ${stop.id}: ${currentLoad.seats} seats > ${vehicle.capacity.seats}`,
          details: { currentLoad, vehicleCapacity: vehicle.capacity, stopIndex: i },
        });
      }
    } else if (isDropoff(stop.type)) {
      currentLoad = subtractCapacity(currentLoad, delta);
    }
  }

  // 5. True ride time check (counts from start of pickup to end of drop-off service)
  for (const transfer of transfers) {
    const pickupStop = stops.find((s) => s.transferId === transfer.id && isPickup(s.type));
    const dropoffStop = stops.find((s) => s.transferId === transfer.id && isDropoff(s.type));
    if (pickupStop && dropoffStop) {
      const passenger = passengerMap.get(transfer.passengerId);
      const maxRide = passenger?.maxRideTimeMinutes ?? passenger?.tiempoMaximoABordoMinutos;
      if (maxRide !== undefined && maxRide !== null) {
        const pStart = parseTimeToMinutes(pickupStop.plannedTime ?? pickupStop.horaPlanificada);
        const dArr = parseTimeToMinutes(dropoffStop.plannedTime ?? dropoffStop.horaPlanificada);
        if (pStart !== undefined && dArr !== undefined) {
          const dServ = dropoffStop.serviceDurationMinutes ?? passenger?.dropoffDurationMinutes ?? defaultServiceDur;
          const rideTime = dArr + dServ - pStart;
          if (rideTime > maxRide) {
            violations.push({
              rule: "max_ride_time_exceeded",
              passengerId: transfer.passengerId,
              transferId: transfer.id,
              message: `Ride time for passenger ${transfer.passengerId} (${rideTime} min) exceeds maximum (${maxRide} min)`,
              details: { rideTimeMinutes: rideTime, maxRideTimeMinutes: maxRide },
            });
          }
        }
      }
    }
  }

  // 6. Target time window check
  for (const transfer of transfers) {
    const dir = transfer.direction ?? transfer.sentido ?? "inbound";
    const isInbound = dir === "inbound" || dir === "entrada";
    const targetStop = isInbound
      ? stops.find((s) => s.transferId === transfer.id && isDropoff(s.type))
      : stops.find((s) => s.transferId === transfer.id && isPickup(s.type));

    if (targetStop) {
      const plannedMins = parseTimeToMinutes(targetStop.plannedTime ?? targetStop.horaPlanificada);
      if (plannedMins !== undefined) {
        let earliest: number | undefined;
        let latest: number | undefined;
        if (transfer.targetWindow) {
          earliest = parseTimeToMinutes(transfer.targetWindow.earliest);
          latest = parseTimeToMinutes(transfer.targetWindow.latest);
        }
        const targetRaw = transfer.targetTime ?? transfer.horaObjetivo;
        if (targetRaw !== undefined) {
          const targetMins = parseTimeToMinutes(targetRaw);
          if (targetMins !== undefined) {
            const earlyTol = transfer.earlyToleranceMinutes ?? defaultEarlyTol;
            const lateTol = transfer.lateToleranceMinutes ?? defaultLateTol;
            if (earliest === undefined) earliest = targetMins - earlyTol;
            if (latest === undefined) latest = targetMins + lateTol;
          }
        }
        if (earliest !== undefined && plannedMins < earliest - 1e-4) {
          violations.push({
            rule: "target_time_window_broken",
            passengerId: transfer.passengerId,
            transferId: transfer.id,
            message: `Stop time (${plannedMins} min) earlier than earliest allowed (${earliest} min)`,
            details: { plannedMinutes: plannedMins, earliestMinutes: earliest, latestMinutes: latest },
          });
        } else if (latest !== undefined && plannedMins > latest + 1e-4) {
          violations.push({
            rule: "target_time_window_broken",
            passengerId: transfer.passengerId,
            transferId: transfer.id,
            message: `Stop time (${plannedMins} min) later than latest allowed (${latest} min)`,
            details: { plannedMinutes: plannedMins, earliestMinutes: earliest, latestMinutes: latest },
          });
        }
      }
    }
  }

  return violations;
}

export function isRouteValid(violations: RouteViolation[]): boolean {
  return violations.length === 0;
}
