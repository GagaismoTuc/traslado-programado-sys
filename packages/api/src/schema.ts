import { integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

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
  actorUserId: integer("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  actorLabel: text("actor_label"),
  entity: text().notNull(),
  entityId: text("entity_id").notNull(),
  action: text().notNull(),
  before: jsonb("before_data"),
  after: jsonb("after_data"),
  occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
});
