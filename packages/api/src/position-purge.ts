import type { PoolClient } from "pg";

/** How long a Posición is kept, counted from its server time (ADR 0002). The only place the retention lives. */
export const POSITION_RETENTION_DAYS = 90;

/** Advisory lock shared by every API instance; namespace 841201 as in bootstrap-office (key 10 is the Office bootstrap). */
export const POSITION_PURGE_LOCK = { namespace: 841201, key: 20 } as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 5000;
const PURGE_FAILED_MESSAGE = "Position purge failed; it will retry on the next run";

export type PurgePool = { connect(): Promise<PoolClient> };
export type PurgeResult = { deleted: number; batches: number; skipped: boolean };

export type PurgeOptions = { now: () => Date; batchSize?: number };

export type PositionPurgeOptions = PurgeOptions & {
  pool: PurgePool;
  intervalMs?: number;
  onError?: (error: unknown) => void;
  onRun?: (result: PurgeResult) => void;
};

/**
 * Deletes the Posiciones whose server time is more than POSITION_RETENTION_DAYS before `now`, in batches of `batchSize`,
 * each in its own short transaction. Only the positions table is touched. When another instance holds the purge lock,
 * the run stops at once and reports `skipped` instead of waiting: that instance is already purging.
 */
export async function purgeExpiredPositions(pool: PurgePool, { now, batchSize = DEFAULT_BATCH_SIZE }: PurgeOptions): Promise<PurgeResult> {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("batchSize must be a positive integer");
  const cutoff = new Date(now().getTime() - POSITION_RETENTION_DAYS * DAY_MS).toISOString();
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    let deleted = 0;
    let batches = 0;
    for (;;) {
      try {
        await client.query("BEGIN");
        const lock = await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_xact_lock($1, $2) AS locked",
          [POSITION_PURGE_LOCK.namespace, POSITION_PURGE_LOCK.key],
        );
        if (!lock.rows[0]?.locked) {
          await client.query("ROLLBACK");
          return { deleted, batches, skipped: true };
        }
        const result = await client.query(
          "DELETE FROM positions WHERE id IN (SELECT id FROM positions WHERE server_time < $1 ORDER BY id LIMIT $2)",
          [cutoff, batchSize],
        );
        await client.query("COMMIT");
        const count = result.rowCount ?? 0;
        deleted += count;
        batches++;
        if (count < batchSize) return { deleted, batches, skipped: false };
      } catch (error) {
        await client.query("ROLLBACK").catch((rollbackError: unknown) => {
          broken = rollbackError instanceof Error ? rollbackError : new Error("ROLLBACK failed");
        });
        throw error;
      }
    }
  } finally {
    // A connection whose ROLLBACK failed is discarded instead of going back to the pool.
    client.release(broken);
  }
}

/** Logs a failed purge with a fixed message and only the error's name and code: the raw error may carry a connection string. */
function logPurgeError(error: unknown) {
  const name = error instanceof Error ? error.name : "unknown";
  const code = typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
  console.error(PURGE_FAILED_MESSAGE, { name, code });
}

/**
 * Runs the purge once now and then every `intervalMs` (24 h) while the API runs. A run never starts while the previous
 * one is still going; a failure is reported through `onError` and the next run retries. It never throws or leaves an
 * unhandled rejection, so the API keeps serving. `stop()` cancels the timer and waits for a run in progress.
 */
export function startPositionPurge({ pool, now, batchSize, intervalMs = DAY_MS, onError = logPurgeError, onRun }: PositionPurgeOptions) {
  let running: Promise<void> | undefined;
  let stopped = false;

  const report = (callback: () => void) => {
    try {
      callback();
    } catch {
      // A failing reporter must not turn into an unhandled rejection.
    }
  };

  const run = () => {
    if (running || stopped) return;
    running = purgeExpiredPositions(pool, { now, batchSize })
      .then((result) => report(() => onRun?.(result)), (error: unknown) => report(() => onError(error)))
      .finally(() => {
        running = undefined;
      });
  };

  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
