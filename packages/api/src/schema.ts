import { boolean, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

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
