import { z } from "zod";
import { parseSpeedFactors, type PlannerSettings } from "./planner.js";
import { readTrustedProxyCidrs } from "./trusted-proxies.js";

const configSchema = z.object({
  SERVER_EPOCH: z.string().trim().min(1, "SERVER_EPOCH is required"),
  DATABASE_URL: z.string().url("DATABASE_URL must be a valid URL"),
  OSRM_URL: z.string({ error: "OSRM_URL must be a valid URL" }).url("OSRM_URL must be a valid URL"),
  VROOM_URL: z.string({ error: "VROOM_URL must be a valid URL" }).url("VROOM_URL must be a valid URL"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().trim().min(1, "HOST must name an address to bind").default("0.0.0.0"),
  ROUTE_GAP_MINUTES: z.coerce.number({ error: "ROUTE_GAP_MINUTES must be a whole number of minutes from 1" })
    .int("ROUTE_GAP_MINUTES must be a whole number of minutes from 1")
    .min(1, "ROUTE_GAP_MINUTES must be a whole number of minutes from 1")
    .default(60),
  RIDE_TIME_BUFFER_MINUTES: z.coerce.number({ error: "RIDE_TIME_BUFFER_MINUTES must be a whole number of minutes from 0" })
    .int("RIDE_TIME_BUFFER_MINUTES must be a whole number of minutes from 0")
    .min(0, "RIDE_TIME_BUFFER_MINUTES must be a whole number of minutes from 0")
    .default(5),
  SPEED_FACTORS: z.string().default("00:00=1"),
  GEOCODER: z.enum(["off", "nominatim"], { error: "GEOCODER must be off or nominatim" }).default("off"),
  NOMINATIM_URL: z.string().url("NOMINATIM_URL must be a valid URL").default("https://nominatim.openstreetmap.org"),
  NOMINATIM_USER_AGENT: z.string().trim().min(1).default("traslado-programado (+https://github.com/GagaismoTuc/traslado-programado-sys)"),
  // Where company staff receive a Pasajero nobody else can receive (`inferido`); empty or unset means not configured.
  BASE_ADDRESS: z.string().trim().max(500, "BASE_ADDRESS must be at most 500 characters").optional(),
  VAPID_PUBLIC_KEY: z.string().trim().optional(),
  VAPID_PRIVATE_KEY: z.string().trim().optional(),
  VAPID_SUBJECT: z.string().trim().default("mailto:soporte@traslado.com"),
});

export type ServerConfig = {
  serverEpoch: string;
  databaseUrl: string;
  osrmUrl: string;
  vroomUrl: string;
  port: number;
  host: string;
  routeGapMinutes: number;
  planner: PlannerSettings;
  trustedOrigins: string[];
  trustedProxyCidrs: string[];
  geocoder: "off" | "nominatim";
  nominatimUrl: string;
  nominatimUserAgent: string;
  baseAddress: string | null;
  vapid: {
    publicKey: string;
    privateKey: string;
    subject: string;
  } | null;
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
  const speedFactors = parseSpeedFactors(result.data.SPEED_FACTORS);
  if (!speedFactors) throw new Error("SPEED_FACTORS must be a comma-separated list of HH:MM=factor with factors above 0 and up to 5");

  const vapid = result.data.VAPID_PUBLIC_KEY && result.data.VAPID_PRIVATE_KEY
    ? {
        publicKey: result.data.VAPID_PUBLIC_KEY,
        privateKey: result.data.VAPID_PRIVATE_KEY,
        subject: result.data.VAPID_SUBJECT,
      }
    : null;

  return {
    serverEpoch: result.data.SERVER_EPOCH,
    databaseUrl: result.data.DATABASE_URL,
    osrmUrl: result.data.OSRM_URL,
    vroomUrl: result.data.VROOM_URL,
    port: result.data.PORT,
    host: result.data.HOST,
    routeGapMinutes: result.data.ROUTE_GAP_MINUTES,
    // The early tolerance mirrors the route validator's default (15, inferido); calibrated later with real plans.
    planner: { rideTimeBufferMinutes: result.data.RIDE_TIME_BUFFER_MINUTES, speedFactors, earlyToleranceMinutes: 15 },
    trustedOrigins: readTrustedOrigins(environment.AUTH_ALLOWED_ORIGINS),
    trustedProxyCidrs: readTrustedProxyCidrs(environment.TRUSTED_PROXY_CIDRS),
    geocoder: result.data.GEOCODER,
    nominatimUrl: result.data.NOMINATIM_URL,
    nominatimUserAgent: result.data.NOMINATIM_USER_AGENT,
    baseAddress: result.data.BASE_ADDRESS || null,
    vapid,
  };
}
