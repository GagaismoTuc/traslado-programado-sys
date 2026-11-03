import { it, expect } from "vitest";
import { createServer } from "node:http";
import { createPool } from "../src/db.js";
import { createApp } from "../src/app.js";
import { createApiErrorTracker } from "../src/error-tracking.js";

it("does not transmit a passenger name in a real PostgreSQL error", async () => {
  const envelopes: string[] = [];
  const receiver = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => { envelopes.push(body); res.end("{}"); });
  });
  await new Promise<void>(resolve => receiver.listen(0, "127.0.0.1", resolve));
  const pool = createPool(process.env.TEST_DATABASE_URL!);
  const port = (receiver.address() as {port: number}).port;
  const tracker = createApiErrorTracker({dsn: `http://${"a".repeat(32)}@127.0.0.1:${port}/1`});
  try {
    const app = createApp({db: pool, routing: {osrm: async()=>{}, vroom: async()=>{}}, errorReporter: tracker.captureRequestError, config: {serverEpoch: "synthetic"}});
    app.get("/failure", async () => { await pool.query("select $1::integer", ["Synthetic Passenger"]); return new Response(); });
    expect((await app.request("http://localhost/failure")).status).toBe(500);
    expect(await tracker.flush()).toBe(true);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).not.toContain("Synthetic Passenger");
  } finally {
    await tracker.close(); await pool.end();
    await new Promise<void>(resolve => receiver.close(() => resolve()));
  }
});

