import { TRASBORDO_WINDOW_MINUTES } from "@traslado/shared";

// Builds the VROOM problem of one Recorrido and reads its solution back as Paradas with planned times.
// Times are seconds since midnight of the Plan diario's day; locations are [lng, lat] as VROOM expects.

export type LngLat = [number, number];

export type SpeedBand = { fromMinutes: number; factor: number };

export type PlannerSettings = {
  // Model-error buffer: the engine plans with the Tiempo máximo a bordo minus these minutes.
  rideTimeBufferMinutes: number;
  // Per-time-band factor applied to OSRM durations (VROOM `speed_factor`); the band of the Recorrido's start applies.
  speedFactors: SpeedBand[];
  // How early before T an entrada may arrive; the validator's defaultEarlyToleranceMinutes (inferido).
  earlyToleranceMinutes: number;
};

export type PlanTransfer = {
  id: number;
  direction: "entrada" | "salida";
  targetMinutes: number;
  // An entrada from another Destino is picked up there not before the Pasajero's exit time.
  notBeforeMinutes?: number;
  pickup: LngLat;
  dropoff: LngLat;
  // 1 + Acompañantes of this Traslado.
  seats: number;
  frontSeat: boolean;
  requiredFeatureIds: number[];
  maxRideMinutes: number;
  pickupMinutes: number;
  dropoffMinutes: number;
  // A Pasajero already on board since this minute (their actual Subió): only the drop-off is left, in this Vehículo.
  boardedMinutes?: number;
  // A leg of a Trasbordo: its end at the Trasbordo point (`stop`) happens in [minutes, minutes + 5].
  trasbordo?: { stop: "pickup" | "dropoff"; minutes: number };
  // Leg B of a Trasbordo rides since leg A's planned pickup (or the original Subió): its ride counts from this minute.
  rideStartMinutes?: number;
};

export type PlanInput = {
  transfers: PlanTransfer[];
  vehicle: { seats: number; featureIds: number[] };
  start: LngLat;
  // The Recorrido may not leave before this (planned end of the previous Recorrido when it chains).
  notBeforeMinutes?: number;
  // null leaves the end open.
  end: LngLat | null;
  startMinutes: number;
};

export type UnassignedReason = "capacity" | "time_window" | "adaptation";

export type PlannedStop = {
  transferId: number;
  kind: "pickup" | "dropoff";
  plannedSeconds: number;
  legDistanceMeters: number | null;
};

export type PlanResult = {
  stops: PlannedStop[];
  unassigned: { transferId: number; reason: UnassignedReason }[];
};

type Window = [number, number];
type VroomStep = {
  type: string;
  id?: number;
  arrival: number;
  waiting_time?: number;
  distance?: number;
};
export type VroomSolution = { unassigned: { id: number; type?: string }[]; routes: { steps: VroomStep[] }[] };
export type VroomProblem = Record<string, unknown>;
export type VroomSolver = (problem: VroomProblem) => Promise<VroomSolution>;

// Objective: kilometres (1 per metre), with a per-hour cost of 1 per minute so the engine does not stretch rides.
export const VEHICLE_COSTS = { per_km: 1000, per_hour: 60 };
// A Plan diario covers one day: no Recorrido runs past midnight.
const DAY_SECONDS = 24 * 3600;
const RELAXED_CAPACITY = 1_000_000;

export function speedFactorAt(bands: SpeedBand[], minutes: number) {
  let factor = 1;
  for (const band of [...bands].sort((a, b) => a.fromMinutes - b.fromMinutes)) {
    if (band.fromMinutes <= minutes) factor = band.factor;
  }
  return factor;
}

/**
 * One window per step. With R' = Tiempo máximo a bordo − buffer:
 * entrada with target arrival T: pickup from T − R' + drop-off service (and not before the exit time from another Destino),
 * drop-off between T − early tolerance and T;
 * salida with pickup P: pickup from P and drop-off finished by P + R'.
 * Either way the ride (pickup start to end of drop-off service) stays within R'. Null when R' cannot hold the drop-off.
 */
export function stepWindows(transfer: PlanTransfer, settings: PlannerSettings): { pickup: Window; dropoff: Window } | null {
  const ride = (transfer.maxRideMinutes - settings.rideTimeBufferMinutes) * 60;
  const dropoffService = transfer.dropoffMinutes * 60;
  const target = transfer.targetMinutes * 60;
  if (ride < dropoffService + transfer.pickupMinutes * 60) return null;
  if (transfer.trasbordo) return trasbordoWindows(transfer, settings, ride);
  if (transfer.direction === "entrada") {
    const earliestPickup = Math.max(0, target - ride + dropoffService, (transfer.notBeforeMinutes ?? 0) * 60);
    if (earliestPickup + transfer.pickupMinutes * 60 > target) return null;
    return {
      pickup: [earliestPickup, target],
      dropoff: [Math.max(0, target - settings.earlyToleranceMinutes * 60), target],
    };
  }
  const latestDropoff = target + ride - dropoffService;
  return { pickup: [target, latestDropoff], dropoff: [target, latestDropoff] };
}

/**
 * A Trasbordo leg's end at the point is held to [t, t + 5]. Leg A (ends there): an entrada is picked up so that its ride
 * to the point fits R', a salida from its pickup at P; leg B (starts there): its drop-off starts by leg A's planned
 * pickup + R' − drop-off service, and an entrada still arrives between T − early tolerance and T.
 */
function trasbordoWindows(transfer: PlanTransfer, settings: PlannerSettings, ride: number) {
  const point: Window = [transfer.trasbordo!.minutes * 60, (transfer.trasbordo!.minutes + TRASBORDO_WINDOW_MINUTES) * 60];
  const dropoffService = transfer.dropoffMinutes * 60;
  const target = transfer.targetMinutes * 60;
  let pickup: Window;
  let dropoff: Window;
  if (transfer.trasbordo!.stop === "dropoff") {
    pickup = transfer.direction === "entrada"
      ? [Math.max(0, point[1] - ride + dropoffService, (transfer.notBeforeMinutes ?? 0) * 60), point[1]]
      : [target, point[1]];
    dropoff = [point[0], Math.min(point[1], pickup[0] + ride - dropoffService)];
  } else {
    const latest = (transfer.rideStartMinutes ?? transfer.trasbordo!.minutes) * 60 + ride - dropoffService;
    pickup = point;
    dropoff = transfer.direction === "entrada"
      ? [Math.max(point[0], target - settings.earlyToleranceMinutes * 60), Math.min(target, latest)]
      : [point[0], latest];
  }
  return pickup[0] <= pickup[1] && dropoff[0] <= dropoff[1] ? { pickup, dropoff } : null;
}

/**
 * Window of an on-board Pasajero's drop-off: the ride counts from the actual Subió (after a Trasbordo, the original one), so the drop-off starts by
 * Subió + R' − drop-off service; an entrada also arrives between T − early tolerance and T, and leg A of a Trasbordo is left at the
 * Trasbordo point in [t, t + 5]. Null when it no longer fits.
 */
export function boardedWindow(transfer: PlanTransfer, settings: PlannerSettings): Window | null {
  const latest = ((transfer.rideStartMinutes ?? transfer.boardedMinutes!) + transfer.maxRideMinutes - settings.rideTimeBufferMinutes - transfer.dropoffMinutes) * 60;
  const target = transfer.targetMinutes * 60;
  const point = transfer.trasbordo?.stop === "dropoff" ? transfer.trasbordo.minutes : null;
  const window: Window = point !== null
    ? [point * 60, Math.min((point + TRASBORDO_WINDOW_MINUTES) * 60, latest)]
    : transfer.direction === "entrada"
      ? [Math.max(0, target - settings.earlyToleranceMinutes * 60), Math.min(target, latest)]
      : [transfer.boardedMinutes! * 60, latest];
  return window[0] <= window[1] ? window : null;
}

function localReason(transfer: PlanTransfer, input: PlanInput, settings: PlannerSettings): UnassignedReason | null {
  const features = new Set(input.vehicle.featureIds);
  if (transfer.requiredFeatureIds.some((feature) => !features.has(feature))) return "adaptation";
  if (transfer.seats > input.vehicle.seats) return "capacity";
  if (!stepWindows(transfer, settings)) return "time_window";
  return null;
}

export function buildProblem(input: PlanInput, settings: PlannerSettings, transfers = input.transfers, relaxed = false): VroomProblem {
  const shipments = transfers.filter((transfer) => transfer.boardedMinutes === undefined);
  const boarded = transfers.filter((transfer) => transfer.boardedMinutes !== undefined);
  return {
    vehicles: [{
      id: 1,
      profile: "car",
      start: input.start,
      ...(input.end ? { end: input.end } : {}),
      capacity: relaxed ? [RELAXED_CAPACITY, RELAXED_CAPACITY] : [input.vehicle.seats, 1],
      time_window: [(input.notBeforeMinutes ?? 0) * 60, DAY_SECONDS],
      speed_factor: speedFactorAt(settings.speedFactors, input.startMinutes),
      costs: VEHICLE_COSTS,
    }],
    // An on-board Pasajero is a job with a delivery: VROOM loads it at the start, in this one Vehículo only.
    ...(boarded.length ? {
      jobs: boarded.map((transfer) => ({
        id: transfer.id,
        location: transfer.dropoff,
        service: transfer.dropoffMinutes * 60,
        delivery: [transfer.seats, transfer.frontSeat ? 1 : 0],
        time_windows: [boardedWindow(transfer, settings)!],
        priority: 100,
      })),
    } : {}),
    shipments: shipments.map((transfer) => {
      const windows = stepWindows(transfer, settings)!;
      return {
        amount: [transfer.seats, transfer.frontSeat ? 1 : 0],
        pickup: { id: transfer.id, location: transfer.pickup, service: transfer.pickupMinutes * 60, time_windows: [windows.pickup] },
        delivery: { id: transfer.id, location: transfer.dropoff, service: transfer.dropoffMinutes * 60, time_windows: [windows.dropoff] },
      };
    }),
    // Geometry makes VROOM report the cumulative distance of each step.
    options: { g: true },
  };
}

export function readSolution(solution: VroomSolution): PlannedStop[] {
  const steps = solution.routes[0]?.steps ?? [];
  const stops: PlannedStop[] = [];
  let previousDistance: number | undefined = steps[0]?.type === "start" ? steps[0].distance : 0;
  for (const step of steps) {
    if (step.type !== "pickup" && step.type !== "delivery" && step.type !== "job") continue;
    const legDistanceMeters = step.distance === undefined || previousDistance === undefined ? null : step.distance - previousDistance;
    previousDistance = step.distance;
    stops.push({
      transferId: step.id!,
      kind: step.type === "pickup" ? "pickup" : "dropoff",
      plannedSeconds: step.arrival + (step.waiting_time ?? 0),
      legDistanceMeters,
    });
  }
  return stops;
}

/**
 * Orders one Recorrido. Every input Traslado ends up in `stops` or in `unassigned`, never dropped;
 * the engine never adds a Vehículo or splits the Recorrido. An on-board Pasajero is never unassigned: when their
 * drop-off no longer fits its window it goes first, at the start time, and the validator reports the ride.
 */
export async function planRoute(input: PlanInput, settings: PlannerSettings, solve: VroomSolver): Promise<PlanResult> {
  const unassigned: PlanResult["unassigned"] = [];
  const candidates: PlanTransfer[] = [];
  const late: PlanTransfer[] = [];
  for (const transfer of input.transfers) {
    if (transfer.boardedMinutes !== undefined) {
      (boardedWindow(transfer, settings) ? candidates : late).push(transfer);
      continue;
    }
    const reason = localReason(transfer, input, settings);
    if (reason) unassigned.push({ transferId: transfer.id, reason });
    else candidates.push(transfer);
  }
  const solved = candidates.length ? readSolution(await solve(buildProblem(input, settings, candidates))) : [];
  const placed = new Set(solved.map((stop) => stop.transferId));
  late.push(...candidates.filter((transfer) => transfer.boardedMinutes !== undefined && !placed.has(transfer.id)));
  const startSeconds = (input.notBeforeMinutes ?? input.startMinutes) * 60;
  const stops: PlannedStop[] = [
    ...late.map((transfer) => ({ transferId: transfer.id, kind: "dropoff" as const, plannedSeconds: startSeconds, legDistanceMeters: null })),
    ...solved,
  ];
  const left = candidates.filter((transfer) => transfer.boardedMinutes === undefined && !placed.has(transfer.id));
  if (left.length) {
    // With seats unlimited, what still does not fit is out because of its time window.
    const relaxed = readSolution(await solve(buildProblem(input, settings, candidates, true)));
    const fitsWithoutCapacity = new Set(relaxed.map((stop) => stop.transferId));
    for (const transfer of left) {
      unassigned.push({ transferId: transfer.id, reason: fitsWithoutCapacity.has(transfer.id) ? "capacity" : "time_window" });
    }
  }
  const order = new Map(input.transfers.map((transfer, index) => [transfer.id, index]));
  unassigned.sort((a, b) => order.get(a.transferId)! - order.get(b.transferId)!);
  return { stops, unassigned };
}

/** "HH:MM=factor,HH:MM=factor": the factor applies from that local time on. */
export function parseSpeedFactors(value: string): SpeedBand[] | null {
  const bands: SpeedBand[] = [];
  for (const entry of value.split(",")) {
    const match = /^\s*([01]\d|2[0-3]):([0-5]\d)\s*=\s*(\d+(?:\.\d+)?)\s*$/.exec(entry);
    if (!match) return null;
    const factor = Number(match[3]);
    if (!(factor > 0 && factor <= 5)) return null;
    bands.push({ fromMinutes: Number(match[1]) * 60 + Number(match[2]), factor });
  }
  return bands.sort((a, b) => a.fromMinutes - b.fromMinutes);
}
