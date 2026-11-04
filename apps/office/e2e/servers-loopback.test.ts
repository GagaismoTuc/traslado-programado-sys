import { createServer } from "node:net";
import { expect, it } from "vitest";
import { startApi } from "./servers";

it("retries when a loopback listener closes every connection", async () => {
  const holder = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) =>
    holder.once("error", reject).listen(24113, "127.0.0.1", resolve));
  let api: Awaited<ReturnType<typeof startApi>> | undefined;
  try {
    api = await startApi(24113, {
      SERVER_EPOCH: "review-check",
      DATABASE_URL: "postgres://u:p@127.0.0.1:9/db",
      OSRM_URL: "http://127.0.0.1:9",
      VROOM_URL: "http://127.0.0.1:9",
      GEOCODER: "off",
    });
    expect(Number(new URL(api.url).port)).not.toBe(24113);
    expect((await fetch(`${api.url}/auth/me`)).status).toBe(401);
  } finally {
    if (api) await api.close();
    await new Promise<void>((resolve) => holder.close(() => resolve()));
  }
}, 60_000);
