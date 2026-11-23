import { afterEach, describe, expect, it, vi } from "vitest";
import {
  POSITION_PURGE_LOCK,
  POSITION_RETENTION_DAYS,
  purgeExpiredPositions,
  startPositionPurge,
  type PurgePool,
  type PurgeResult,
} from "../src/position-purge.js";
import { createExecutionHarness, HOME } from "./helpers/execution.js";

const { appPool, migrationPool, rows, setup, markBody, mark, answer } = createExecutionHarness("position-purge-test");

// Rule 1's example: today is 2027-03-01, so the cutoff is 2026-12-01 00:00 UTC.
const PURGE_NOW = new Date("2027-03-01T00:00:00.000Z");
const now = () => PURGE_NOW;
const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRED = "2026-11-30T23:59:00.000Z";
const KEPT = "2026-12-01T00:01:00.000Z";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** One Recorrido with its Chofer, which positions must reference. Synthetic data only. */
async function recorrido(name: string) {
  const { passenger, served } = await setup(name);
  const { passengerId } = await passenger();
  const { driver, routeId, transferId } = await served(passengerId, "entrada");
  return { routeId, driverId: driver.driverId, driver, transferId };
}

async function insertPosition(routeId: number, driverId: number, serverTime: string) {
  await appPool.query(
    `INSERT INTO positions (route_id, driver_id, latitude, longitude, accuracy_meters, phone_time, server_time)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [routeId, driverId, HOME.lat, HOME.lng, 10, serverTime, serverTime],
  );
}

/** `count` expired Posiciones, one minute apart, all older than the cutoff. */
async function insertExpired(routeId: number, driverId: number, count: number) {
  for (let index = 0; index < count; index++) {
    await insertPosition(routeId, driverId, new Date(Date.parse(EXPIRED) - index * 60_000).toISOString());
  }
}

async function storedServerTimes() {
  return (await rows("SELECT server_time FROM positions ORDER BY server_time")).map((row) => row.server_time.toISOString());
}

async function tableCounts() {
  const tables = await rows("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
  const counts: Record<string, number> = {};
  for (const { tablename } of tables as Array<{ tablename: string }>) {
    const result = await rows(`SELECT count(*)::int AS count FROM public."${tablename.replaceAll('"', '""')}"`);
    counts[tablename] = result[0].count;
  }
  return counts;
}

function withTimeout<T>(promise: Promise<T>, ms: number) {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)),
  ]);
}

/** Collects each run's result from the scheduler so a test can wait for the next one. */
function runRecorder() {
  const results: PurgeResult[] = [];
  const waiters: Array<() => void> = [];
  return {
    results,
    onRun: (result: PurgeResult) => {
      results.push(result);
      waiters.splice(0).forEach((wake) => wake());
    },
    async waitFor(count: number) {
      while (results.length < count) await withTimeout(new Promise<void>((wake) => waiters.push(wake)), 5000);
    },
  };
}

describe("Regla 1 (S1): 90-day retention by server time", () => {
  it("on 2027-03-01 deletes a Posición of 2026-11-30 23:59 UTC and keeps one of 2026-12-01 00:01 UTC", async () => {
    const { routeId, driverId } = await recorrido("rule1");
    await insertPosition(routeId, driverId, EXPIRED);
    await insertPosition(routeId, driverId, KEPT);

    // The application role (traslado_app) runs the purge, proving it holds DELETE on positions.
    const result = await purgeExpiredPositions(appPool, { now });

    expect(result).toEqual({ deleted: 1, batches: 1, skipped: false });
    expect(await storedServerTimes()).toEqual([KEPT]);
  });
});

describe("S6: the retention lives in one constant", () => {
  it("keeps the retention in POSITION_RETENTION_DAYS = 90 and keeps a Posición exactly 90 days old", async () => {
    expect(POSITION_RETENTION_DAYS).toBe(90);
    const { routeId, driverId } = await recorrido("s6");
    const cutoff = new Date(PURGE_NOW.getTime() - POSITION_RETENTION_DAYS * DAY_MS).toISOString();
    expect(cutoff).toBe("2026-12-01T00:00:00.000Z");
    const justOlder = new Date(Date.parse(cutoff) - 1).toISOString();
    await insertPosition(routeId, driverId, justOlder);
    await insertPosition(routeId, driverId, cutoff);

    expect(await purgeExpiredPositions(appPool, { now })).toEqual({ deleted: 1, batches: 1, skipped: false });
    expect(await storedServerTimes()).toEqual([cutoff]);
  });
});

describe("Regla 2 (S2, S7): runs at startup and every 24 hours, in batches", () => {
  it("deletes in batches of batchSize until a batch comes back short", async () => {
    const { routeId, driverId } = await recorrido("rule2-batches");
    await insertExpired(routeId, driverId, 5);
    await insertPosition(routeId, driverId, KEPT);

    expect(await purgeExpiredPositions(appPool, { now, batchSize: 2 })).toEqual({ deleted: 5, batches: 3, skipped: false });
    expect(await storedServerTimes()).toEqual([KEPT]);
  });

  it("purges once at startup and again 24 hours later, not before", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { routeId, driverId } = await recorrido("rule2-schedule");
    await insertPosition(routeId, driverId, EXPIRED);
    await insertPosition(routeId, driverId, KEPT);
    let connects = 0;
    const pool: PurgePool = { connect: () => { connects++; return appPool.connect(); } };
    const recorder = runRecorder();

    const purge = startPositionPurge({ pool, now, onRun: recorder.onRun });
    try {
      await recorder.waitFor(1);
      expect(recorder.results[0]).toEqual({ deleted: 1, batches: 1, skipped: false });
      expect(await storedServerTimes()).toEqual([KEPT]);

      await insertPosition(routeId, driverId, "2026-11-29T10:00:00.000Z");
      const connectsAfterStartup = connects;
      vi.advanceTimersByTime(DAY_MS - 1);
      expect(connects).toBe(connectsAfterStartup);
      expect(recorder.results).toHaveLength(1);

      vi.advanceTimersByTime(1);
      await recorder.waitFor(2);
      expect(recorder.results[1]).toEqual({ deleted: 1, batches: 1, skipped: false });
      expect(await storedServerTimes()).toEqual([KEPT]);
    } finally {
      await purge.stop();
    }
  });

  it("does not start a new run while the previous one is still in progress", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let connects = 0;
    let release!: () => void;
    const pool: PurgePool = {
      connect: () => {
        connects++;
        return new Promise((_resolve, reject) => { release = () => reject(new Error("synthetic stop")); });
      },
    };
    const onError = vi.fn();

    const purge = startPositionPurge({ pool, now, onError });
    expect(connects).toBe(1);
    vi.advanceTimersByTime(DAY_MS);
    vi.advanceTimersByTime(DAY_MS);
    expect(connects).toBe(1);
    release();
    await purge.stop();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("Regla 3 (S3): a failed purge is logged and retried on the next run", () => {
  it("reports a database failure, never rejects, and the next 24-hour run deletes the expired Posiciones", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { routeId, driverId } = await recorrido("rule3");
    await insertPosition(routeId, driverId, EXPIRED);
    await insertPosition(routeId, driverId, KEPT);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    let down = true;
    const pool: PurgePool = {
      connect: () => (down ? Promise.reject(new Error("connect ECONNREFUSED (synthetic database down)")) : appPool.connect()),
    };
    const errors: unknown[] = [];
    const recorder = runRecorder();

    const purge = startPositionPurge({ pool, now, onError: (error) => errors.push(error), onRun: recorder.onRun });
    try {
      await vi.waitFor(() => expect(errors).toHaveLength(1), { timeout: 5000 });
      expect((errors[0] as Error).message).toMatch(/ECONNREFUSED/);
      expect(recorder.results).toEqual([]);
      expect(await storedServerTimes()).toEqual([EXPIRED, KEPT]);

      down = false;
      vi.advanceTimersByTime(DAY_MS);
      await recorder.waitFor(1);
      expect(recorder.results[0]).toEqual({ deleted: 1, batches: 1, skipped: false });
      expect(await storedServerTimes()).toEqual([KEPT]);
      expect(errors).toHaveLength(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await purge.stop();
    }
  });

  it("logs a failure by default with a fixed message and the error's name and code, never the raw error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = Object.assign(new Error("password authentication failed for postgres://user:secret@db/traslado"), { code: "28P01" });
    const pool: PurgePool = { connect: () => Promise.reject(failure) };

    const purge = startPositionPurge({ pool, now });
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await purge.stop();

    expect(consoleError).toHaveBeenCalledWith(
      "Position purge failed; it will retry on the next run",
      { name: "Error", code: "28P01" },
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("secret");
  });
});

describe("Regla 4 (S4): two API instances purging at once", () => {
  it("lets two concurrent purges finish without error and together delete exactly the expired Posiciones", async () => {
    const { routeId, driverId } = await recorrido("rule4-concurrent");
    await insertExpired(routeId, driverId, 7);
    await insertPosition(routeId, driverId, KEPT);
    const otherPool = { connect: () => appPool.connect() };

    const [first, second] = await withTimeout(Promise.all([
      purgeExpiredPositions(appPool, { now, batchSize: 2 }),
      purgeExpiredPositions(otherPool, { now, batchSize: 2 }),
    ]), 5000);

    expect(first.deleted + second.deleted).toBe(7);
    expect(await storedServerTimes()).toEqual([KEPT]);
  });

  it("skips the run without waiting while another instance holds the purge lock", async () => {
    const { routeId, driverId } = await recorrido("rule4-lock");
    await insertPosition(routeId, driverId, EXPIRED);
    await insertPosition(routeId, driverId, KEPT);
    const holder = await migrationPool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock($1, $2)", [POSITION_PURGE_LOCK.namespace, POSITION_PURGE_LOCK.key]);

      expect(await withTimeout(purgeExpiredPositions(appPool, { now }), 2000)).toEqual({ deleted: 0, batches: 0, skipped: true });
      expect(await storedServerTimes()).toEqual([EXPIRED, KEPT]);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }

    expect(await purgeExpiredPositions(appPool, { now })).toEqual({ deleted: 1, batches: 1, skipped: false });
    expect(await storedServerTimes()).toEqual([KEPT]);
  });
});

describe("Regla 5 (S5, S7): the purge never touches Marcas or any other table", () => {
  it("leaves the Marcas, with their location, and every other table unchanged", async () => {
    const { routeId, driverId, driver, transferId } = await recorrido("rule5");
    await answer(mark(driver.cookie, routeId, markBody(transferId, "subio")), 201);
    await insertExpired(routeId, driverId, 3);
    await insertPosition(routeId, driverId, KEPT);
    const marksBefore = await rows("SELECT * FROM marks ORDER BY id");
    expect(marksBefore).toHaveLength(1);
    expect(marksBefore[0]).toMatchObject({ latitude: HOME.lat, longitude: HOME.lng });
    const countsBefore = await tableCounts();

    // The Marca's server time (2026-10-23) is also more than 90 days before 2027-03-01.
    expect(await purgeExpiredPositions(appPool, { now })).toEqual({ deleted: 3, batches: 1, skipped: false });

    expect(await rows("SELECT * FROM marks ORDER BY id")).toEqual(marksBefore);
    expect(await tableCounts()).toEqual({ ...countsBefore, positions: 1 });
    expect(await storedServerTimes()).toEqual([KEPT]);
  });
});
