import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

export function createPool(connectionString: string) {
  return new Pool({ connectionString, options: "-c timezone=UTC" });
}

export function createDrizzle(pool: Pool) {
  return drizzle(pool);
}
