// DIAGNOSTIC (#101): summarises the JSON lines written by packages/api/test/profile.ts. Removed before the PR.
import { readFileSync } from "node:fs";
const rows = readFileSync(process.argv[2], "utf8").trim().split("\n").map((line) => JSON.parse(line));
const tests = rows.filter((row) => row.file !== "routing-stack-start");
const stack = rows.filter((row) => row.file === "routing-stack-start");
const sum = (key) => tests.reduce((total, row) => total + (row[key] ?? 0), 0);
const t0 = Math.min(...rows.map((row) => row.start));
console.log(`tests=${tests.length} wall=${sum("wall")} cpu=${sum("cpu")} argon2=${sum("argon2")} (${sum("argon2Calls")} calls) db=${sum("db")} (${sum("dbCalls")} calls) truncate=${sum("truncate")}`);
for (const row of stack) console.log(`routing stack start: t=${((row.start - t0) / 1000).toFixed(1)}s..${((row.start + row.wall - t0) / 1000).toFixed(1)}s wall=${row.wall}`);
const routing = tests.filter((row) => row.file.endsWith("routing.test.ts"));
for (const row of routing) console.log(`routing test t=${((row.start - t0) / 1000).toFixed(1)}s wall=${row.wall} ${row.test.slice(0, 60)}`);
console.log("slowest 40: t(s) worker wall cpu argon2(n) db(n) truncate file test");
for (const row of [...tests].sort((a, b) => b.wall - a.wall).slice(0, 40)) {
  console.log([((row.start - t0) / 1000).toFixed(1), row.worker, row.wall, row.cpu, `${row.argon2}(${row.argon2Calls})`, `${row.db}(${row.dbCalls})`, row.truncate, row.file, row.test.slice(0, 70)].join("\t"));
}
// Per 10-second window: mean ratio wall/cpu of the tests that started in it, to see contention windows.
const windows = new Map();
for (const row of tests) {
  const bucket = Math.floor((row.start - t0) / 10000);
  const entry = windows.get(bucket) ?? { n: 0, wall: 0, cpu: 0, argon2: 0, argon2Calls: 0, db: 0 };
  entry.n++; entry.wall += row.wall; entry.cpu += row.cpu; entry.argon2 += row.argon2; entry.argon2Calls += row.argon2Calls; entry.db += row.db;
  windows.set(bucket, entry);
}
console.log("window(s) n wall cpu argon2/call db");
for (const [bucket, entry] of [...windows].sort((a, b) => a[0] - b[0])) {
  console.log(`${bucket * 10}\t${entry.n}\t${entry.wall}\t${entry.cpu}\t${entry.argon2Calls ? Math.round(entry.argon2 / entry.argon2Calls) : "-"}\t${entry.db}`);
}
