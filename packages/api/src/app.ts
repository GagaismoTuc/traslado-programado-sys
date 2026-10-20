import { Hono } from "hono";
import type { ServerEpoch } from "@traslado/shared";

export type HealthDatabase = {
  query: (sql: string) => Promise<unknown>;
};

export type AppConfig = {
  serverEpoch: ServerEpoch;
  healthTimeoutMs?: number;
};

export function createApp({ db, config }: { db: HealthDatabase; config: AppConfig }) {
  if (!config.serverEpoch.trim()) throw new Error("SERVER_EPOCH is required");
  const healthTimeoutMs = config.healthTimeoutMs ?? 1000;
  const app = new Hono()
    .use("*", async (context, next) => {
    try {
      await next();
    } finally {
      context.header("X-Server-Epoch", config.serverEpoch);
    }
    })
    .get("/health", async (context) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        db.query("SELECT 1"),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Database health check timed out")), healthTimeoutMs);
        }),
      ]);
      return context.body(null, 200);
    } catch {
      return context.body(null, 503);
    } finally {
      if (timer) clearTimeout(timer);
    }
    });

  app.onError((_error, context) => {
    context.header("X-Server-Epoch", config.serverEpoch);
    return context.body(null, 500);
  });

  return app;
}

export type AppType = ReturnType<typeof createApp>;
