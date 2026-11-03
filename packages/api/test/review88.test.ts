import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { createApiErrorTracker } from "../src/error-tracking.js";
import { createApp } from "../src/app.js";
import { createOfficeErrorTracker } from "../../../apps/office/src/error-tracking.js";
import { createDriverErrorTracker } from "../../../apps/driver/src/error-tracking.js";

describe("independent privacy checks", () => {
  it.each(["api", "office", "driver"])("removes unstructured passenger data from the %s envelope", async (kind) => {
    const bodies: string[] = [];
    const receiver = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", chunk => body += chunk);
      req.on("end", () => { bodies.push(body); res.writeHead(200); res.end("{}"); });
    });
    await new Promise<void>(resolve => receiver.listen(0, "127.0.0.1", resolve));
    try {
      const port = (receiver.address() as {port: number}).port;
      const dsn = `http://${"a".repeat(32)}@127.0.0.1:${port}/1`;
      const failure = new Error("Failed saving passenger Synthetic Passenger at Synthetic Road 42");
      if (kind === "api") {
        const tracker = createApiErrorTracker({ dsn });
        const app = createApp({ db: {query: async () => ({rows: [],rowCount: 0})} as any, routing: {osrm: async()=>{},vroom: async()=>{}}, errorReporter: tracker.captureRequestError, config: {serverEpoch:"synthetic"} });
        app.get("/failure", () => { throw failure; });
        expect((await app.request("http://localhost/failure")).status).toBe(500);
        expect(await tracker.flush()).toBe(true);
        await tracker.close();
      } else {
        const tracker = kind === "office" ? createOfficeErrorTracker({ dsn }) : createDriverErrorTracker({ dsn });
        tracker.captureError(failure);
        expect(await tracker.flush()).toBe(true);
      }
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).not.toContain("Synthetic Passenger");
      expect(bodies[0]).not.toContain("Synthetic Road 42");
    } finally {
      await new Promise<void>(resolve => receiver.close(() => resolve()));
    }
  });
});

