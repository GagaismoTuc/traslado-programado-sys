import { sql } from "drizzle-orm";
import { boolean, check, doublePrecision, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const foundationPermissionProbe = pgTable("foundation_permission_probe", {
  id: integer().generatedAlwaysAsIdentity().primaryKey(),
  marker: text().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
});

export const users = pgTable("users", {
  id: integer().generatedAlwaysAsIdentity().primaryKey(),
  username: text().notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text().notNull(),
  disabledAt: timestamp("disabled_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
  persistentSession: boolean("persistent_session").default(false).notNull(),
  totpSecret: text("totp_secret"),
  totpConfirmedAt: timestamp("totp_confirmed_at", { withTimezone: true, mode: "string" }),
  totpLastStep: integer("totp_last_step"),
}, (table) => [uniqueIndex("users_username_unique").on(table.username)]);

export const sessions = pgTable("sessions", {
  id: integer().generatedAlwaysAsIdentity().primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  tokenHash: text("token_hash").notNull().unique(),
  deviceLabel: text("device_label").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
  endedReason: text("ended_reason"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
  secondFactorAt: timestamp("second_factor_at", { withTimezone: true, mode: "string" }),
});

export const rememberedDevices = pgTable("remembered_devices", {
  id: integer().generatedAlwaysAsIdentity().primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  sessionId: integer("session_id").notNull().references(() => sessions.id),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
});

export const changeLog = pgTable("change_log", {
  id: integer().generatedAlwaysAsIdentity().primaryKey(),
  actorUserId: integer("actor_user_id").references(() => users.id, { onDelete: "restrict" }),
  actorLabel: text("actor_label"),
  entity: text().notNull(),
  entityId: text("entity_id").notNull(),
  action: text().notNull(),
  before: jsonb("before_data"),
  after: jsonb("after_data"),
  occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
});

export const destinations = pgTable("destinations", {
  id: integer().generatedAlwaysAsIdentity().primaryKey(),
  name: text().notNull(),
  kind: text().notNull(),
  address: text().notNull(),
  accessNotes: text("access_notes"),
  latitude: doublePrecision().notNull(),
  longitude: doublePrecision().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
  check("destinations_kind_check", sql`${table.kind} IN ('school', 'clinic', 'therapy', 'day_centre', 'other')`),
  check("destinations_latitude_check", sql`${table.latitude} BETWEEN -90 AND 90`),
  check("destinations_longitude_check", sql`${table.longitude} BETWEEN -180 AND 180`),
]);

export const vehicleFeatures = pgTable("vehicle_features", {
  id: integer().generatedAlwaysAsIdentity().primaryKey(),
  name: text().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("vehicle_features_name_lower_unique").on(sql`lower(${table.name})`),
]);

export const vehicles = pgTable("vehicles", {
  id: integer().generatedAlwaysAsIdentity().primaryKey(),
  plate: text().notNull(),
  model: text().notNull(),
  seats: integer().notNull(),
  frontSeats: integer("front_seats").default(1).notNull(),
  deactivatedAt: timestamp("deactivated_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("vehicles_active_plate_unique").on(sql`upper(${table.plate})`).where(sql`${table.deactivatedAt} IS NULL`),
  check("vehicles_seats_positive", sql`${table.seats} > 0`),
  check("vehicles_front_seats_check", sql`${table.frontSeats} = 1`),
]);

export const vehicleFeatureAssignments = pgTable("vehicle_feature_assignments", {
  vehicleId: integer("vehicle_id").notNull().references(() => vehicles.id, { onDelete: "cascade" }),
  featureId: integer("feature_id").notNull().references(() => vehicleFeatures.id, { onDelete: "restrict" }),
}, (table) => [
  primaryKey({ columns: [table.vehicleId, table.featureId] }),
]);

export const drivers = pgTable("drivers", {
  id: integer().generatedAlwaysAsIdentity().primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  name: text().notNull(),
  homeAddress: text("home_address").notNull(),
  homeLatitude: doublePrecision("home_latitude").notNull(),
  homeLongitude: doublePrecision("home_longitude").notNull(),
  usualVehicleId: integer("usual_vehicle_id").references(() => vehicles.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("drivers_user_id_unique").on(table.userId),
  check("drivers_home_latitude_check", sql`${table.homeLatitude} BETWEEN -90 AND 90`),
  check("drivers_home_longitude_check", sql`${table.homeLongitude} BETWEEN -180 AND 180`),
]);
