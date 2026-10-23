import { z } from "zod";

const configSchema = z.object({
  SERVER_EPOCH: z.string().trim().min(1, "SERVER_EPOCH is required"),
  DATABASE_URL: z.string().url("DATABASE_URL must be a valid URL"),
  OSRM_URL: z.string().url("OSRM_URL must be a valid URL"),
  VROOM_URL: z.string().url("VROOM_URL must be a valid URL"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});

export type ServerConfig = {
  serverEpoch: string;
  databaseUrl: string;
  osrmUrl: string;
  vroomUrl: string;
  port: number;
};

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
    osrmUrl: result.data.OSRM_URL,
    vroomUrl: result.data.VROOM_URL,
    port: result.data.PORT,
  };
}
