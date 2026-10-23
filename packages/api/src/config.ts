import { z } from "zod";

const configSchema = z.object({
  SERVER_EPOCH: z.string().trim().min(1, "SERVER_EPOCH is required"),
  DATABASE_URL: z.string().url("DATABASE_URL must be a valid URL"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});

export type ServerConfig = {
  serverEpoch: string;
  databaseUrl: string;
  port: number;
  trustedOrigins: string[];
};

const DEFAULT_TRUSTED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
];

function readTrustedOrigins(value: string | undefined) {
  if (!value?.trim()) return DEFAULT_TRUSTED_ORIGINS;
  return value.split(",").map((entry) => {
    const origin = entry.trim();
    try {
      const url = new URL(origin);
      if (url.origin !== origin || !["http:", "https:"].includes(url.protocol)) throw new Error();
      return origin;
    } catch {
      throw new Error("AUTH_ALLOWED_ORIGINS must be a comma-separated list of origins");
    }
  });
}

export function readConfig(environment: NodeJS.ProcessEnv = process.env): ServerConfig {
  if (!environment.SERVER_EPOCH?.trim()) throw new Error("SERVER_EPOCH is required");
  const result = configSchema.safeParse(environment);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(issues);
  }

  return {
    serverEpoch: result.data.SERVER_EPOCH,
    databaseUrl: result.data.DATABASE_URL,
    port: result.data.PORT,
    trustedOrigins: readTrustedOrigins(environment.AUTH_ALLOWED_ORIGINS),
  };
}
