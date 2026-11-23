import { sql } from "drizzle-orm";
import {
  type AnyPgColumn, boolean, check, date, doublePrecision, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, time, timestamp, unique, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

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

export const pushSubscriptions = pgTable("push_subscriptions", {
  id: integer().generatedAlwaysAsIdentity().primaryKey(),
  sessionId: integer("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  endpoint: text().notNull(),
  p256dh: text().notNull(),
  auth: text().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("push_subscriptions_endpoint_unique").on(table.endpoint),
  index("push_subscriptions_session_id_idx").on(table.sessionId),
]);

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
  // Tolerancia de llegada: minutes after an entrada's target time that arrival is still accepted.
  arrivalToleranceMinutes: integer("arrival_tolerance_minutes").default(0).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
  check("destinations_arrival_tolerance_check", sql`${table.arrivalToleranceMinutes} BETWEEN 0 AND 240`),
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

// A document of exactly one Vehículo or one Chofer: only its name and its Vencimiento (null: no date yet), never a file.
export const documents = pgTable("documents", {
  id: integer().generatedAlwaysAsIdentity().primaryKey(),
  vehicleId: integer("vehicle_id").references(() => vehicles.id, { onDelete: "restrict" }),
  driverId: integer("driver_id").references(() => drivers.id, { onDelete: "restrict" }),
  name: text().notNull(),
  expiresOn: date("expires_on", { mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
  check("documents_one_owner_check", sql`(${table.vehicleId} IS NULL) <> (${table.driverId} IS NULL)`),
  check("documents_name_check", sql`btrim(${table.name}) <> ''`),
  uniqueIndex("documents_vehicle_name_unique").on(table.vehicleId, sql`lower(${table.name})`).where(sql`${table.vehicleId} IS NOT NULL`),
  uniqueIndex("documents_driver_name_unique").on(table.driverId, sql`lower(${table.name})`).where(sql`${table.driverId} IS NOT NULL`),
]);

// Only what drivers and the planner need: no diagnosis, sex or gender, and no reason for the front-seat requirement.
export const passengers = pgTable("passengers", {
  id: integer().generatedAlwaysAsIdentity().primaryKey(),
  name: text().notNull(),
  homeAddress: text("home_address").notNull(),
  homeLatitude: doublePrecision("home_latitude").notNull(),
  homeLongitude: doublePrecision("home_longitude").notNull(),
  accessNotes: text("access_notes"),
  companions: integer().notNull(),
  frontSeat: boolean("front_seat").notNull(),
  wheelchair: boolean().notNull(),
  maxRideTimeMinutes: integer("max_ride_time_minutes").notNull(),
  pickupDurationMinutes: integer("pickup_duration_minutes").notNull(),
  dropoffDurationMinutes: integer("dropoff_duration_minutes").notNull(),
  medicalAlert: text("medical_alert"),
  deactivatedAt: timestamp("deactivated_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
  check("passengers_home_latitude_check", sql`${table.homeLatitude} BETWEEN -90 AND 90`),
  check("passengers_home_longitude_check", sql`${table.homeLongitude} BETWEEN -180 AND 180`),
  check("passengers_companions_check", sql`${table.companions} BETWEEN 0 AND 2`),
  check("passengers_max_ride_time_positive", sql`${table.maxRideTimeMinutes} > 0`),
  check("passengers_pickup_duration_positive", sql`${table.pickupDurationMinutes} > 0`),
  check("passengers_dropoff_duration_positive", sql`${table.dropoffDurationMinutes} > 0`),
  check("passengers_medical_alert_length", sql`char_length(${table.medicalAlert}) <= 140`),
]);

export const passengerRequiredFeatures = pgTable("passenger_required_features", {
  passengerId: integer("passenger_id").notNull().references(() => passengers.id, { onDelete: "restrict" }),
  featureId: integer("feature_id").notNull().references(() => vehicleFeatures.id, { onDelete: "restrict" }),
}, (table) => [
  primaryKey({ columns: [table.passengerId, table.featureId] }),
]);

// A Responsable legal is the Adulto autorizado who signed the Consentimiento; only they can give an Autorización puntual.
// Removing an adult sets removed_at, so a Marca or an Autorización puntual that names them keeps its reference.
export const authorizedAdults = pgTable("authorized_adults", {
  id: integer().generatedAlwaysAsIdentity().primaryKey(),
  passengerId: integer("passenger_id").notNull().references(() => passengers.id, { onDelete: "restrict" }),
  name: text().notNull(),
  dni: text().notNull(),
  relation: text().notNull(),
  phone: text().notNull(),
  legalGuardian: boolean("legal_guardian").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
  removedAt: timestamp("removed_at", { withTimezone: true, mode: "string" }),
}, (table) => [
  unique("authorized_adults_id_passenger_unique").on(table.id, table.passengerId),
]);

// One Consentimiento per Pasajero, signed by one of that Pasajero's Adultos autorizados (the composite key keeps it the same Pasajero).
export const consents = pgTable("consents", {
  passengerId: integer("passenger_id").primaryKey().references(() => passengers.id, { onDelete: "restrict" }),
  signedByAdultId: integer("signed_by_adult_id").notNull(),
  signedAt: date("signed_at", { mode: "string" }).notNull(),
  otherAdultAllowed: boolean("other_adult_allowed").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
  foreignKey({
    name: "consents_signed_by_adult_fk",
    columns: [table.signedByAdultId, table.passengerId],
    foreignColumns: [authorizedAdults.id, authorizedAdults.passengerId],
  }).onDelete("restrict"),
]);

// Times of a Plan diario are local wall-clock times (`time`, no offset) in the plan's zone, which v1 fixes to Tucumán.
export const dailyPlans = pgTable("daily_plans", {
  id: integer().generatedAlwaysAsIdentity().primaryKey(),
  planDate: date("plan_date", { mode: "string" }).notNull(),
  timeZone: text("time_zone").default("America/Argentina/Tucuman").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("daily_plans_plan_date_unique").on(table.planDate),
  check("daily_plans_time_zone_check", sql`${table.timeZone} = 'America/Argentina/Tucuman'`),
]);

export const routes = pgTable("routes", {
  id: integer().generatedAlwaysAsIdentity().primaryKey(),
  dailyPlanId: integer("daily_plan_id").notNull().references(() => dailyPlans.id, { onDelete: "restrict" }),
  driverId: integer("driver_id").notNull().references(() => drivers.id, { onDelete: "restrict" }),
  vehicleId: integer("vehicle_id").notNull().references(() => vehicles.id, { onDelete: "restrict" }),
  startTime: time("start_time").notNull(),
  endTime: time("end_time").notNull(),
  status: text().default("borrador").notNull(),
  // Where the engine starts and ends the Recorrido; null keeps the default rule (home, chained or open).
  startKind: text("start_kind"),
  startLatitude: doublePrecision("start_latitude"),
  startLongitude: doublePrecision("start_longitude"),
  endKind: text("end_kind"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
  check("routes_status_check", sql`${table.status} IN ('borrador', 'publicado', 'en_curso', 'cerrado')`),
  check("routes_time_band_check", sql`${table.endTime} >= ${table.startTime}`),
  check("routes_start_kind_check", sql`${table.startKind} IN ('home', 'previous', 'point')`),
  check(
    "routes_start_point_check",
    sql`(${table.startKind} = 'point' AND ${table.startLatitude} BETWEEN -90 AND 90 AND ${table.startLongitude} BETWEEN -180 AND 180)
      OR (${table.startKind} IS DISTINCT FROM 'point' AND ${table.startLatitude} IS NULL AND ${table.startLongitude} IS NULL)`,
  ),
  check("routes_end_kind_check", sql`${table.endKind} IN ('home', 'open')`),
]);

// An entrada may start at another Destino (origin) instead of home; a salida always ends at home.
// exit_time is when the Pasajero leaves that first Destino: the API requires it for such entradas, and rows from
// before the field existed keep it null until the Oficina sets it.
// A Trasbordo splits a Traslado into chained legs: leg B names the leg A it continues (chained_from_transfer_id), and each
// leg's end at the Trasbordo point (trasbordo_stop: A's drop-off, B's pickup) is there at trasbordo_time instead of at
// home or at a Destino.
export const transfers = pgTable("transfers", {
  id: integer().generatedAlwaysAsIdentity().primaryKey(),
  dailyPlanId: integer("daily_plan_id").notNull().references(() => dailyPlans.id, { onDelete: "restrict" }),
  passengerId: integer("passenger_id").notNull().references(() => passengers.id, { onDelete: "restrict" }),
  direction: text().notNull(),
  destinationId: integer("destination_id").notNull().references(() => destinations.id, { onDelete: "restrict" }),
  originDestinationId: integer("origin_destination_id").references(() => destinations.id, { onDelete: "restrict" }),
  targetTime: time("target_time").notNull(),
  exitTime: time("exit_time"),
  companions: integer().notNull(),
  status: text().default("planificado").notNull(),
  chainedFromTransferId: integer("chained_from_transfer_id").references((): AnyPgColumn => transfers.id, { onDelete: "restrict" }),
  trasbordoStop: text("trasbordo_stop"),
  trasbordoLatitude: doublePrecision("trasbordo_latitude"),
  trasbordoLongitude: doublePrecision("trasbordo_longitude"),
  trasbordoTime: time("trasbordo_time"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("transfers_chained_from_unique").on(table.chainedFromTransferId),
  check(
    "transfers_trasbordo_check",
    sql`(${table.trasbordoStop} IS NULL AND ${table.trasbordoLatitude} IS NULL AND ${table.trasbordoLongitude} IS NULL AND ${table.trasbordoTime} IS NULL)
      OR (${table.trasbordoStop} IN ('pickup', 'dropoff') AND ${table.trasbordoLatitude} BETWEEN -90 AND 90
        AND ${table.trasbordoLongitude} BETWEEN -180 AND 180 AND ${table.trasbordoTime} IS NOT NULL)`,
  ),
  check("transfers_chain_check", sql`${table.chainedFromTransferId} IS NULL OR ${table.trasbordoStop} = 'pickup'`),
  check("transfers_direction_check", sql`${table.direction} IN ('entrada', 'salida')`),
  check("transfers_status_check", sql`${table.status} IN ('planificado', 'subio', 'entregado', 'ausente', 'cancelado_ausencia')`),
  check("transfers_companions_check", sql`${table.companions} BETWEEN 0 AND 2`),
  check(
    "transfers_origin_check",
    sql`${table.originDestinationId} IS NULL OR (${table.direction} = 'entrada' AND ${table.originDestinationId} <> ${table.destinationId})`,
  ),
  check(
    "transfers_exit_time_check",
    sql`${table.exitTime} IS NULL OR (${table.originDestinationId} IS NOT NULL AND ${table.exitTime} < ${table.targetTime})`,
  ),
]);

// A Traslado is assigned to a Recorrido by its two Paradas; the unique index keeps it in one Recorrido at most.
// leg_distance_meters is the leg that ends at this Parada and planned_time the engine's start of the Parada,
// both stored for the current order only.
export const stops = pgTable("stops", {
  id: integer().generatedAlwaysAsIdentity().primaryKey(),
  routeId: integer("route_id").notNull().references(() => routes.id, { onDelete: "restrict" }),
  transferId: integer("transfer_id").notNull().references(() => transfers.id, { onDelete: "restrict" }),
  kind: text().notNull(),
  position: integer().notNull(),
  legDistanceMeters: integer("leg_distance_meters"),
  plannedTime: time("planned_time"),
}, (table) => [
  uniqueIndex("stops_transfer_kind_unique").on(table.transferId, table.kind),
  check("stops_kind_check", sql`${table.kind} IN ('pickup', 'dropoff')`),
  check("stops_leg_distance_check", sql`${table.legDistanceMeters} >= 0`),
]);

// A Versión del plan is a published state of one Recorrido; it and its rows are append-only (the app role has no UPDATE or DELETE).
// start_time/end_time and vehicle/driver are the Recorrido as it was published; violations are the limits a forced version broke.
export const planVersions = pgTable("plan_versions", {
  id: integer().generatedAlwaysAsIdentity().primaryKey(),
  routeId: integer("route_id").notNull().references(() => routes.id, { onDelete: "restrict" }),
  version: integer().notNull(),
  vehicleId: integer("vehicle_id").notNull().references(() => vehicles.id, { onDelete: "restrict" }),
  driverId: integer("driver_id").notNull().references(() => drivers.id, { onDelete: "restrict" }),
  startTime: time("start_time").notNull(),
  endTime: time("end_time").notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
  publishedBy: integer("published_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  overrideReason: text("override_reason"),
  violations: jsonb().default([]).notNull(),
  // Hash of everything the publication read about the Recorrido: equal on the next one means nothing changed since.
  inputSignature: text("input_signature").notNull(),
}, (table) => [
  uniqueIndex("plan_versions_route_version_unique").on(table.routeId, table.version),
  check("plan_versions_version_positive", sql`${table.version} > 0`),
  check("plan_versions_override_reason_check", sql`${table.overrideReason} IS NULL OR btrim(${table.overrideReason}) <> ''`),
]);

// One row per Parada of the version, in order; the leg ends at that Parada (the first leg is 0: the Recorrido starts there).
export const planVersionLegs = pgTable("plan_version_legs", {
  planVersionId: integer("plan_version_id").notNull().references(() => planVersions.id, { onDelete: "restrict" }),
  position: integer().notNull(),
  transferId: integer("transfer_id").notNull().references(() => transfers.id, { onDelete: "restrict" }),
  kind: text().notNull(),
  distanceMeters: integer("distance_meters").notNull(),
  durationSeconds: integer("duration_seconds").notNull(),
  plannedTime: time("planned_time").notNull(),
}, (table) => [
  primaryKey({ columns: [table.planVersionId, table.position] }),
  check("plan_version_legs_kind_check", sql`${table.kind} IN ('pickup', 'dropoff')`),
  check("plan_version_legs_distance_check", sql`${table.distanceMeters} >= 0`),
  check("plan_version_legs_duration_check", sql`${table.durationSeconds} >= 0`),
]);

// The Traslados a version serves, with their Acompañantes and Distancia directa (the km per Traslado) at publication.
export const planVersionTransfers = pgTable("plan_version_transfers", {
  planVersionId: integer("plan_version_id").notNull().references(() => planVersions.id, { onDelete: "restrict" }),
  transferId: integer("transfer_id").notNull().references(() => transfers.id, { onDelete: "restrict" }),
  companions: integer().notNull(),
  directDistanceMeters: integer("direct_distance_meters").notNull(),
}, (table) => [
  primaryKey({ columns: [table.planVersionId, table.transferId] }),
  check("plan_version_transfers_direct_distance_check", sql`${table.directDistanceMeters} >= 0`),
]);

// A Confirmación de versión: the Chofer saw this Versión del plan. Append-only (the app role has no UPDATE or DELETE);
// the unique index makes a repeated acknowledgement of the same version a no-op.
export const versionAcknowledgements = pgTable("version_acknowledgements", {
  id: integer().generatedAlwaysAsIdentity().primaryKey(),
  planVersionId: integer("plan_version_id").notNull().references(() => planVersions.id, { onDelete: "restrict" }),
  driverId: integer("driver_id").notNull().references(() => drivers.id, { onDelete: "restrict" }),
  sessionId: integer("session_id").notNull().references(() => sessions.id, { onDelete: "restrict" }),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("version_acknowledgements_version_driver_unique").on(table.planVersionId, table.driverId),
]);

// An Autorización puntual: a Responsable legal, called by the Oficina on their registered phone, lets one named adult
// receive the Pasajero on one Traslado. Append-only (the app role has no UPDATE or DELETE); a revocation is its own row.
export const oneOffAuthorizations = pgTable("one_off_authorizations", {
  id: integer().generatedAlwaysAsIdentity().primaryKey(),
  transferId: integer("transfer_id").notNull().references(() => transfers.id, { onDelete: "restrict" }),
  authorizedByAdultId: integer("authorized_by_adult_id").notNull().references(() => authorizedAdults.id, { onDelete: "restrict" }),
  // The registered phone the Oficina called, as it was when the call was made.
  calledPhone: text("called_phone").notNull(),
  name: text().notNull(),
  dni: text().notNull(),
  recordedBy: integer("recorded_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
});

export const oneOffAuthorizationRevocations = pgTable("one_off_authorization_revocations", {
  authorizationId: integer("authorization_id").primaryKey().references(() => oneOffAuthorizations.id, { onDelete: "restrict" }),
  revokedBy: integer("revoked_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
});

// A Marca as the Chofer's phone made it: client_id is the phone's UUID, so a resent Marca is found instead of stored twice.
// Append-only (the app role has no UPDATE or DELETE). flags are why the server accepted it with a warning.
// A Corrección is a Marca naming the one it replaces in corrects_mark_id, with the corrected outcome or 'undo'. The
// Oficina's carries a reason and no Chofer; its session says who made it.
export const marks = pgTable("marks", {
  id: integer().generatedAlwaysAsIdentity().primaryKey(),
  clientId: uuid("client_id").notNull(),
  transferId: integer("transfer_id").notNull().references(() => transfers.id, { onDelete: "restrict" }),
  planVersionId: integer("plan_version_id").notNull().references(() => planVersions.id, { onDelete: "restrict" }),
  driverId: integer("driver_id").references(() => drivers.id, { onDelete: "restrict" }),
  correctsMarkId: integer("corrects_mark_id").references((): AnyPgColumn => marks.id, { onDelete: "restrict" }),
  reason: text(),
  sessionId: integer("session_id").notNull().references(() => sessions.id, { onDelete: "restrict" }),
  kind: text().notNull(),
  phoneTime: timestamp("phone_time", { withTimezone: true, mode: "string" }).notNull(),
  serverTime: timestamp("server_time", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
  latitude: doublePrecision(),
  longitude: doublePrecision(),
  receiverKind: text("receiver_kind"),
  receiverAdultId: integer("receiver_adult_id").references(() => authorizedAdults.id, { onDelete: "restrict" }),
  receiverDestinationId: integer("receiver_destination_id").references(() => destinations.id, { onDelete: "restrict" }),
  receiverName: text("receiver_name"),
  receiverDni: text("receiver_dni"),
  authorizationId: integer("authorization_id").references(() => oneOffAuthorizations.id, { onDelete: "restrict" }),
  // The receiving Chofer of a Trasbordo; the Subió in the receiving Recorrido names the Entregado it continues.
  receiverDriverId: integer("receiver_driver_id").references(() => drivers.id, { onDelete: "restrict" }),
  trasbordoMarkId: integer("trasbordo_mark_id").references((): AnyPgColumn => marks.id, { onDelete: "restrict" }),
  flags: jsonb().default([]).notNull(),
}, (table) => [
  uniqueIndex("marks_client_id_unique").on(table.clientId),
  // A later Corrección replaces the Corrección; once the one that replaced a Marca is undone, the Marca can be corrected again.
  index("marks_corrects_mark_id_index").on(table.correctsMarkId),
  check("marks_kind_check", sql`${table.kind} IN ('subio', 'ausente', 'entregado', 'undo')`),
  check("marks_undo_check", sql`${table.kind} <> 'undo' OR ${table.correctsMarkId} IS NOT NULL`),
  // Only a Corrección carries a reason, and one without a Chofer is the Oficina's, which always has one.
  check("marks_reason_check", sql`${table.reason} IS NULL OR ${table.correctsMarkId} IS NOT NULL`),
  check("marks_office_correction_check", sql`${table.driverId} IS NOT NULL OR ${table.reason} IS NOT NULL`),
  check(
    "marks_location_check",
    sql`(${table.latitude} IS NULL AND ${table.longitude} IS NULL)
      OR (${table.latitude} BETWEEN -90 AND 90 AND ${table.longitude} BETWEEN -180 AND 180)`,
  ),
  // Entregado requires a Receptor, and only Entregado has one.
  check("marks_receiver_check", sql`(${table.kind} = 'entregado') = (${table.receiverKind} IS NOT NULL)`),
  check("marks_receiver_driver_check", sql`(${table.receiverKind} = 'driver') = (${table.receiverDriverId} IS NOT NULL)`),
  check("marks_trasbordo_mark_check", sql`${table.trasbordoMarkId} IS NULL OR ${table.kind} = 'subio'`),
  check(
    "marks_receiver_kind_check",
    sql`${table.receiverKind} IS NULL
      OR (${table.receiverKind} = 'authorized_adult' AND ${table.receiverAdultId} IS NOT NULL AND ${table.receiverDestinationId} IS NULL
        AND ${table.receiverName} IS NULL AND ${table.receiverDni} IS NULL AND ${table.authorizationId} IS NULL)
      OR (${table.receiverKind} = 'destination' AND ${table.receiverDestinationId} IS NOT NULL AND ${table.receiverAdultId} IS NULL
        AND ${table.receiverName} IS NULL AND ${table.receiverDni} IS NULL AND ${table.authorizationId} IS NULL)
      OR (${table.receiverKind} = 'other_adult' AND ${table.receiverName} IS NOT NULL AND ${table.receiverDni} IS NOT NULL
        AND ${table.receiverAdultId} IS NULL AND ${table.receiverDestinationId} IS NULL)
      OR (${table.receiverKind} IN ('base_staff', 'driver') AND ${table.receiverAdultId} IS NULL AND ${table.receiverDestinationId} IS NULL
        AND ${table.receiverName} IS NULL AND ${table.receiverDni} IS NULL AND ${table.authorizationId} IS NULL)`,
  ),
]);

// The Oficina's alert inbox; later tickets add kinds. dedupe_key keeps a repeated event (a resent Marca) to one alert.
export const alerts = pgTable("alerts", {
  id: integer().generatedAlwaysAsIdentity().primaryKey(),
  kind: text().notNull(),
  transferId: integer("transfer_id").references(() => transfers.id, { onDelete: "restrict" }),
  routeId: integer("route_id").references(() => routes.id, { onDelete: "restrict" }),
  markId: integer("mark_id").references(() => marks.id, { onDelete: "restrict" }),
  details: jsonb().default({}).notNull(),
  dedupeKey: text("dedupe_key"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("alerts_dedupe_key_unique").on(table.dedupeKey),
  check(
    "alerts_kind_check",
    sql`${table.kind} IN ('other_adult_handover', 'mark_flagged', 'mark_conflict', 'authorization_conflict', 'absent_on_entrada', 'close_refused')`,
  ),
]);

export const absences = pgTable("absences", {
  id: integer().generatedAlwaysAsIdentity().primaryKey(),
  transferId: integer("transfer_id").notNull().references(() => transfers.id, { onDelete: "restrict" }),
  createdBy: integer("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("absences_transfer_unique").on(table.transferId),
]);

// A Posición reported by the Chofer's phone during Seguimiento of a Recorrido en curso.
// Stored separately from Marcas (never purged) and never references Pasajeros; purged after 90 days.
// The app role can SELECT, INSERT and DELETE (for the 90-day purge), never UPDATE.
export const positions = pgTable("positions", {
  id: integer().generatedAlwaysAsIdentity().primaryKey(),
  routeId: integer("route_id").notNull().references(() => routes.id, { onDelete: "restrict" }),
  driverId: integer("driver_id").notNull().references(() => drivers.id, { onDelete: "restrict" }),
  latitude: doublePrecision().notNull(),
  longitude: doublePrecision().notNull(),
  accuracyMeters: doublePrecision("accuracy_meters").notNull(),
  phoneTime: timestamp("phone_time", { withTimezone: true, mode: "string" }).notNull(),
  serverTime: timestamp("server_time", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("positions_route_phone_time_unique").on(table.routeId, table.phoneTime),
  index("positions_server_time_index").on(table.serverTime),
  check("positions_latitude_check", sql`${table.latitude} BETWEEN -90 AND 90`),
  check("positions_longitude_check", sql`${table.longitude} BETWEEN -180 AND 180`),
  check("positions_accuracy_check", sql`${table.accuracyMeters} >= 0 AND ${table.accuracyMeters} < 'Infinity'::double precision`),
]);
