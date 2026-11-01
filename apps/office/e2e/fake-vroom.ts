import { createServer, type Server } from "node:http";

type Step = { id: number; time_windows: number[][] };
type Shipment = { amount: number[]; pickup: Step; delivery: Step };

// Stand-in for VROOM in the C3 tests: every shipment that fits is picked up when its window opens and dropped off when
// its window closes, in input order. The API's own planner builds the windows, so the planned times are the API's.
export async function startFakeVroom(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    if (request.method === "GET") {
      response.writeHead(200).end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const problem = JSON.parse(body) as { vehicles: { capacity: number[] }[]; shipments: Shipment[] };
      const capacity = problem.vehicles[0].capacity;
      const load = [0, 0];
      const taken: Shipment[] = [];
      const unassigned: { id: number; type: string }[] = [];
      for (const shipment of problem.shipments) {
        if (load.every((value, index) => value + shipment.amount[index] <= capacity[index])) {
          shipment.amount.forEach((value, index) => { load[index] += value; });
          taken.push(shipment);
        } else {
          unassigned.push({ id: shipment.pickup.id, type: "pickup" });
        }
      }
      const steps = [
        { type: "start", arrival: 0, distance: 0 },
        ...taken.map((shipment, index) => ({ type: "pickup", id: shipment.pickup.id, arrival: shipment.pickup.time_windows[0][0], distance: 1000 * (index + 1) })),
        ...taken.map((shipment, index) => ({
          type: "delivery", id: shipment.delivery.id, arrival: shipment.delivery.time_windows[0][1], distance: 1000 * (taken.length + index + 1),
        })),
      ];
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ unassigned, routes: taken.length ? [{ steps }] : [] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
