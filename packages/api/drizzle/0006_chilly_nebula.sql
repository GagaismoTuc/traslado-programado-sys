CREATE TABLE "absences" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "absences_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"transfer_id" integer NOT NULL,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_plans" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "daily_plans_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"plan_date" date NOT NULL,
	"time_zone" text DEFAULT 'America/Argentina/Tucuman' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_plans_time_zone_check" CHECK ("daily_plans"."time_zone" = 'America/Argentina/Tucuman')
);
--> statement-breakpoint
CREATE TABLE "routes" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "routes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"daily_plan_id" integer NOT NULL,
	"driver_id" integer NOT NULL,
	"vehicle_id" integer NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"status" text DEFAULT 'borrador' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routes_status_check" CHECK ("routes"."status" IN ('borrador', 'publicado', 'en_curso', 'cerrado')),
	CONSTRAINT "routes_time_band_check" CHECK ("routes"."end_time" >= "routes"."start_time")
);
--> statement-breakpoint
CREATE TABLE "stops" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "stops_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"route_id" integer NOT NULL,
	"transfer_id" integer NOT NULL,
	"kind" text NOT NULL,
	"position" integer NOT NULL,
	"leg_distance_meters" integer,
	CONSTRAINT "stops_kind_check" CHECK ("stops"."kind" IN ('pickup', 'dropoff')),
	CONSTRAINT "stops_leg_distance_check" CHECK ("stops"."leg_distance_meters" >= 0)
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "transfers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"daily_plan_id" integer NOT NULL,
	"passenger_id" integer NOT NULL,
	"direction" text NOT NULL,
	"destination_id" integer NOT NULL,
	"origin_destination_id" integer,
	"target_time" time NOT NULL,
	"companions" integer NOT NULL,
	"status" text DEFAULT 'planificado' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfers_direction_check" CHECK ("transfers"."direction" IN ('entrada', 'salida')),
	CONSTRAINT "transfers_status_check" CHECK ("transfers"."status" IN ('planificado', 'subio', 'entregado', 'ausente', 'cancelado_ausencia')),
	CONSTRAINT "transfers_companions_check" CHECK ("transfers"."companions" BETWEEN 0 AND 2),
	CONSTRAINT "transfers_origin_check" CHECK ("transfers"."origin_destination_id" IS NULL OR ("transfers"."direction" = 'entrada' AND "transfers"."origin_destination_id" <> "transfers"."destination_id"))
);
--> statement-breakpoint
ALTER TABLE "absences" ADD CONSTRAINT "absences_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absences" ADD CONSTRAINT "absences_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_daily_plan_id_daily_plans_id_fk" FOREIGN KEY ("daily_plan_id") REFERENCES "public"."daily_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stops" ADD CONSTRAINT "stops_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stops" ADD CONSTRAINT "stops_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_daily_plan_id_daily_plans_id_fk" FOREIGN KEY ("daily_plan_id") REFERENCES "public"."daily_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_passenger_id_passengers_id_fk" FOREIGN KEY ("passenger_id") REFERENCES "public"."passengers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_destination_id_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."destinations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_origin_destination_id_destinations_id_fk" FOREIGN KEY ("origin_destination_id") REFERENCES "public"."destinations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "absences_transfer_unique" ON "absences" USING btree ("transfer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_plans_plan_date_unique" ON "daily_plans" USING btree ("plan_date");--> statement-breakpoint
CREATE UNIQUE INDEX "stops_transfer_kind_unique" ON "stops" USING btree ("transfer_id","kind");