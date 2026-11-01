CREATE TABLE "alerts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "alerts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"transfer_id" integer,
	"route_id" integer,
	"mark_id" integer,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alerts_kind_check" CHECK ("alerts"."kind" IN ('other_adult_handover', 'mark_flagged', 'mark_conflict', 'authorization_conflict', 'absent_on_entrada'))
);
--> statement-breakpoint
CREATE TABLE "marks" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "marks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"client_id" uuid NOT NULL,
	"transfer_id" integer NOT NULL,
	"plan_version_id" integer NOT NULL,
	"driver_id" integer NOT NULL,
	"session_id" integer NOT NULL,
	"kind" text NOT NULL,
	"phone_time" timestamp with time zone NOT NULL,
	"server_time" timestamp with time zone DEFAULT now() NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	"receiver_kind" text,
	"receiver_adult_id" integer,
	"receiver_destination_id" integer,
	"receiver_name" text,
	"receiver_dni" text,
	"authorization_id" integer,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "marks_kind_check" CHECK ("marks"."kind" IN ('subio', 'ausente', 'entregado')),
	CONSTRAINT "marks_location_check" CHECK (("marks"."latitude" IS NULL AND "marks"."longitude" IS NULL)
      OR ("marks"."latitude" BETWEEN -90 AND 90 AND "marks"."longitude" BETWEEN -180 AND 180)),
	CONSTRAINT "marks_receiver_check" CHECK (("marks"."kind" = 'entregado') = ("marks"."receiver_kind" IS NOT NULL)),
	CONSTRAINT "marks_receiver_kind_check" CHECK ("marks"."receiver_kind" IS NULL
      OR ("marks"."receiver_kind" = 'authorized_adult' AND "marks"."receiver_adult_id" IS NOT NULL AND "marks"."receiver_destination_id" IS NULL
        AND "marks"."receiver_name" IS NULL AND "marks"."receiver_dni" IS NULL AND "marks"."authorization_id" IS NULL)
      OR ("marks"."receiver_kind" = 'destination' AND "marks"."receiver_destination_id" IS NOT NULL AND "marks"."receiver_adult_id" IS NULL
        AND "marks"."receiver_name" IS NULL AND "marks"."receiver_dni" IS NULL AND "marks"."authorization_id" IS NULL)
      OR ("marks"."receiver_kind" = 'other_adult' AND "marks"."receiver_name" IS NOT NULL AND "marks"."receiver_dni" IS NOT NULL
        AND "marks"."receiver_adult_id" IS NULL AND "marks"."receiver_destination_id" IS NULL)
      OR ("marks"."receiver_kind" = 'base_staff' AND "marks"."receiver_adult_id" IS NULL AND "marks"."receiver_destination_id" IS NULL
        AND "marks"."receiver_name" IS NULL AND "marks"."receiver_dni" IS NULL AND "marks"."authorization_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "one_off_authorization_revocations" (
	"authorization_id" integer PRIMARY KEY NOT NULL,
	"revoked_by" integer NOT NULL,
	"revoked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "one_off_authorizations" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "one_off_authorizations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"transfer_id" integer NOT NULL,
	"authorized_by_adult_id" integer NOT NULL,
	"called_phone" text NOT NULL,
	"name" text NOT NULL,
	"dni" text NOT NULL,
	"recorded_by" integer NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "authorized_adults" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_mark_id_marks_id_fk" FOREIGN KEY ("mark_id") REFERENCES "public"."marks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marks" ADD CONSTRAINT "marks_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marks" ADD CONSTRAINT "marks_plan_version_id_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marks" ADD CONSTRAINT "marks_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marks" ADD CONSTRAINT "marks_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marks" ADD CONSTRAINT "marks_receiver_adult_id_authorized_adults_id_fk" FOREIGN KEY ("receiver_adult_id") REFERENCES "public"."authorized_adults"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marks" ADD CONSTRAINT "marks_receiver_destination_id_destinations_id_fk" FOREIGN KEY ("receiver_destination_id") REFERENCES "public"."destinations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marks" ADD CONSTRAINT "marks_authorization_id_one_off_authorizations_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."one_off_authorizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_off_authorization_revocations" ADD CONSTRAINT "one_off_authorization_revocations_authorization_id_one_off_authorizations_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."one_off_authorizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_off_authorization_revocations" ADD CONSTRAINT "one_off_authorization_revocations_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_off_authorizations" ADD CONSTRAINT "one_off_authorizations_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_off_authorizations" ADD CONSTRAINT "one_off_authorizations_authorized_by_adult_id_authorized_adults_id_fk" FOREIGN KEY ("authorized_by_adult_id") REFERENCES "public"."authorized_adults"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_off_authorizations" ADD CONSTRAINT "one_off_authorizations_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_dedupe_key_unique" ON "alerts" USING btree ("dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "marks_client_id_unique" ON "marks" USING btree ("client_id");--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE "marks", "one_off_authorizations", "one_off_authorization_revocations" FROM traslado_app;
