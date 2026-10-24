import { sql } from "drizzle-orm";
import { check, doublePrecision, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

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
}, (table) => [uniqueIndex("users_username_unique").on(table.username)]);

export const sessions = pgTable("sessions", {
  id: integer().generatedAlwaysAsIdentity().primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  tokenHash: text("token_hash").notNull().unique(),
  deviceLabel: text("device_label").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
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
