import type { Pool } from "pg";

/**
 * Ignores the 57P01 that Postgres sends when `DROP DATABASE … WITH (FORCE)` terminates a connection of `pool`, and
 * rethrows any other connection error. `pool.end()` resolves before its sockets close, so a drop right after it can
 * still terminate a connection that is closing; without a listener the pool reports that as an unhandled error (#75).
 */
export function ignoreAdministratorTermination(pool: Pool) {
  pool.on("error", (error) => {
    if (!("code" in error) || error.code !== "57P01") throw error;
  });
  return pool;
}
