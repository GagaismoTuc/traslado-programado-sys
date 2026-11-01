CREATE TABLE "plan_version_legs" (
	"plan_version_id" integer NOT NULL,
	"position" integer NOT NULL,
	"transfer_id" integer NOT NULL,
	"kind" text NOT NULL,
	"distance_meters" integer NOT NULL,
	"duration_seconds" integer NOT NULL,
	"planned_time" time NOT NULL,
	CONSTRAINT "plan_version_legs_plan_version_id_position_pk" PRIMARY KEY("plan_version_id","position"),
	CONSTRAINT "plan_version_legs_kind_check" CHECK ("plan_version_legs"."kind" IN ('pickup', 'dropoff')),
	CONSTRAINT "plan_version_legs_distance_check" CHECK ("plan_version_legs"."distance_meters" >= 0),
	CONSTRAINT "plan_version_legs_duration_check" CHECK ("plan_version_legs"."duration_seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE "plan_version_transfers" (
	"plan_version_id" integer NOT NULL,
	"transfer_id" integer NOT NULL,
	"companions" integer NOT NULL,
	"direct_distance_meters" integer NOT NULL,
	CONSTRAINT "plan_version_transfers_plan_version_id_transfer_id_pk" PRIMARY KEY("plan_version_id","transfer_id"),
	CONSTRAINT "plan_version_transfers_direct_distance_check" CHECK ("plan_version_transfers"."direct_distance_meters" >= 0)
);
--> statement-breakpoint
CREATE TABLE "plan_versions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "plan_versions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"route_id" integer NOT NULL,
	"version" integer NOT NULL,
	"vehicle_id" integer NOT NULL,
	"driver_id" integer NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by" integer NOT NULL,
	"override_reason" text,
	"violations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "plan_versions_version_positive" CHECK ("plan_versions"."version" > 0),
	CONSTRAINT "plan_versions_override_reason_check" CHECK ("plan_versions"."override_reason" IS NULL OR btrim("plan_versions"."override_reason") <> '')
);
--> statement-breakpoint
ALTER TABLE "plan_version_legs" ADD CONSTRAINT "plan_version_legs_plan_version_id_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_version_legs" ADD CONSTRAINT "plan_version_legs_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_version_transfers" ADD CONSTRAINT "plan_version_transfers_plan_version_id_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_version_transfers" ADD CONSTRAINT "plan_version_transfers_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plan_versions_route_version_unique" ON "plan_versions" USING btree ("route_id","version");--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE "plan_versions", "plan_version_legs", "plan_version_transfers" FROM traslado_app;
