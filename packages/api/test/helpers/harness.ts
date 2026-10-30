import { generateHOTP } from "@oslojs/otp";
import { afterAll } from "vitest";
import { createApp, type AppType, type HealthDatabase, type RoutingHealth } from "../../src/app.js";
import { hashPassword } from "../../src/auth.js";
import { createPool } from "../../src/db.js";

const routingUp: RoutingHealth = { osrm: async () => undefined, vroom: async () => undefined };
export const TOTP_KEY = new Uint8Array(20).fill(7);
export const START = new Date("2026-10-23T12:00:00.000Z");

/** Test app on a controllable clock (`config.now`) with helpers for cookies, seeding and TOTP codes. */
export function createHarness(name: string) {
  const appPool = createPool(process.env.TEST_DATABASE_URL!);
  const migrationPool = createPool(process.env.TEST_MIGRATION_DATABASE_URL!);
  afterAll(async () => {
    await Promise.all([appPool.end(), migrationPool.end()]);
  });
  let ip = 0;
  const clock = { now: new Date(START) };
  const newApp = (db: HealthDatabase = appPool) => createApp({
    db,
    routing: routingUp,
    config: { serverEpoch: name, now: () => clock.now, getClientIp: () => `198.51.100.${ip}` },
  });
  const app = newApp();
  async function request(path: string, method = "GET", body?: unknown, cookie?: string, target: AppType = app): Promise<Response> {
    return await target.request(path, {
      method,
      headers: {
        Origin: "http://localhost",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function login(username: string, password = "password", deviceLabel = "Test device", cookie?: string, target: AppType = app) {
    const response = await request("/auth/login", "POST", { username, password, deviceLabel }, cookie, target);
    return { response, cookie: cookieFrom(response, "session"), body: await response.clone().json() };
  }
  return {
    appPool,
    migrationPool,
    clock,
    app,
    newApp,
    request,
    login,
    reset() {
      clock.now = new Date(START);
      ip++;
    },
    advance(ms: number) {
      clock.now = new Date(clock.now.getTime() + ms);
    },
    async seed(username: string, role: "office" | "driver", options: { enrolled?: boolean; persistent?: boolean } = {}) {
      const enrolled = role === "office" && (options.enrolled ?? true);
      const result = await migrationPool.query(
        `INSERT INTO users (username, password_hash, role, totp_secret, totp_confirmed_at, persistent_session)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [username, await hashPassword("password"), role, enrolled ? Buffer.from(TOTP_KEY).toString("base64url") : null, enrolled ? START : null, options.persistent ?? false],
      );
      return Number(result.rows[0].id);
    },
    code(offset = 0, key = TOTP_KEY) {
      return generateHOTP(key, BigInt(Math.floor(clock.now.getTime() / 30000) + offset), 6);
    },
  };
}

export function cookieFrom(response: Response, name: string) {
  const token = response.headers.get("set-cookie")?.match(new RegExp(`(?:^|, )${name}=([^;]+)`))?.[1];
  return token ? `${name}=${token}` : "";
}
