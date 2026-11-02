// DIAGNOSTIC (#101): per-test time breakdown, written as JSON lines to $TEST_PROFILE. Removed before the PR.
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, beforeEach } from "vitest";

const file = process.env.TEST_PROFILE;
type Counters = { argon2: number; argon2Calls: number; db: number; dbCalls: number; truncate: number };
const zero = (): Counters => ({ argon2: 0, argon2Calls: 0, db: 0, dbCalls: 0, truncate: 0 });
const state = { current: zero() };
(globalThis as Record<string, unknown>).__profile = state;

if (file) {
  const require = createRequire(import.meta.url);
  const crypto = require("node:crypto");
  const original = crypto.argon2;
  crypto.argon2 = (algorithm: string, parameters: unknown, callback: (error: unknown, digest: Buffer) => void) => {
    const started = performance.now();
    const counters = state.current;
    original(algorithm, parameters, (error: unknown, digest: Buffer) => {
      counters.argon2 += performance.now() - started;
      counters.argon2Calls++;
      callback(error, digest);
    });
  };
  require("node:module").syncBuiltinESMExports();

  const pg = require("pg");
  const query = pg.Client.prototype.query;
  pg.Client.prototype.query = function (this: unknown, ...args: unknown[]) {
    const started = performance.now();
    const counters = state.current;
    const done = () => {
      counters.db += performance.now() - started;
      counters.dbCalls++;
    };
    const last = args.length - 1;
    if (typeof args[last] === "function") {
      const callback = args[last] as (...rest: unknown[]) => void;
      args[last] = (...rest: unknown[]) => {
        done();
        callback(...rest);
      };
      return query.apply(this, args);
    }
    const result = query.apply(this, args);
    if (result && typeof result.then === "function") result.then(done, done);
    return result;
  };
}

let started = 0;
let startedAt = 0;
let cpu = process.cpuUsage();
beforeEach(() => {
  state.current = zero();
  started = performance.now();
  startedAt = Date.now();
  cpu = process.cpuUsage();
});
afterEach((context) => {
  if (!file) return;
  const used = process.cpuUsage(cpu);
  const counters = state.current;
  appendFileSync(file, `${JSON.stringify({
    worker: process.env.VITEST_POOL_ID,
    file: context.task.file?.name,
    test: context.task.name,
    start: startedAt,
    wall: Math.round(performance.now() - started),
    cpu: Math.round((used.user + used.system) / 1000),
    argon2: Math.round(counters.argon2),
    argon2Calls: counters.argon2Calls,
    db: Math.round(counters.db),
    dbCalls: counters.dbCalls,
    truncate: Math.round(counters.truncate),
  })}\n`);
});
