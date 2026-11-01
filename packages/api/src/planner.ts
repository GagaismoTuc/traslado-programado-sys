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
  pickup: LngLat;
  dropoff: LngLat;
  // 1 + Acompañantes of this Traslado.
  seats: number;
  frontSeat: boolean;
  requiredFeatureIds: number[];
  maxRideMinutes: number;
  pickupMinutes: number;
  dropoffMinutes: number;
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
 * entrada with target arrival T: pickup from T − R' + drop-off service, drop-off between T − early tolerance and T;
 * salida with pickup P: pickup from P and drop-off finished by P + R'.
 * Either way the ride (pickup start to end of drop-off service) stays within R'. Null when R' cannot hold the drop-off.
 */
export function stepWindows(transfer: PlanTransfer, settings: PlannerSettings): { pickup: Window; dropoff: Window } | null {
  const ride = (transfer.maxRideMinutes - settings.rideTimeBufferMinutes) * 60;
  const dropoffService = transfer.dropoffMinutes * 60;
  const target = transfer.targetMinutes * 60;
  if (ride < dropoffService + transfer.pickupMinutes * 60) return null;
  if (transfer.direction === "entrada") {
    return {
      pickup: [Math.max(0, target - ride + dropoffService), target],
      dropoff: [Math.max(0, target - settings.earlyToleranceMinutes * 60), target],
    };
  }
  const latestDropoff = target + ride - dropoffService;
  return { pickup: [target, latestDropoff], dropoff: [target, latestDropoff] };
}

function localReason(transfer: PlanTransfer, input: PlanInput, settings: PlannerSettings): UnassignedReason | null {
  const features = new Set(input.vehicle.featureIds);
  if (transfer.requiredFeatureIds.some((feature) => !features.has(feature))) return "adaptation";
  if (transfer.seats > input.vehicle.seats) return "capacity";
  if (!stepWindows(transfer, settings)) return "time_window";
  return null;
}

export function buildProblem(input: PlanInput, settings: PlannerSettings, transfers = input.transfers, relaxed = false): VroomProblem {
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
    shipments: transfers.map((transfer) => {
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
    if (step.type !== "pickup" && step.type !== "delivery") continue;
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
 * the engine never adds a Vehículo or splits the Recorrido.
 */
export async function planRoute(input: PlanInput, settings: PlannerSettings, solve: VroomSolver): Promise<PlanResult> {
  const unassigned: PlanResult["unassigned"] = [];
  const candidates: PlanTransfer[] = [];
  for (const transfer of input.transfers) {
    const reason = localReason(transfer, input, settings);
    if (reason) unassigned.push({ transferId: transfer.id, reason });
    else candidates.push(transfer);
  }
  if (!candidates.length) return { stops: [], unassigned };

  const stops = readSolution(await solve(buildProblem(input, settings, candidates)));
  const placed = new Set(stops.map((stop) => stop.transferId));
  const left = candidates.filter((transfer) => !placed.has(transfer.id));
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
