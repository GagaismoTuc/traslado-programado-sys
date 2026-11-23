CREATE TABLE "incidents" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "incidents_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"client_id" uuid NOT NULL,
	"route_id" integer NOT NULL,
	"driver_id" integer NOT NULL,
	"session_id" integer NOT NULL,
	"kind" text NOT NULL,
	"note" text NOT NULL,
	"phone_time" timestamp with time zone NOT NULL,
	"server_time" timestamp with time zone DEFAULT now() NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	CONSTRAINT "incidents_kind_check" CHECK ("incidents"."kind" IN ('delay', 'vehicle_fault', 'accident', 'health_crisis', 'other')),
	CONSTRAINT "incidents_location_check" CHECK (("incidents"."latitude" IS NULL AND "incidents"."longitude" IS NULL)
      OR ("incidents"."latitude" BETWEEN -90 AND 90 AND "incidents"."longitude" BETWEEN -180 AND 180))
);
--> statement-breakpoint
ALTER TABLE "alerts" DROP CONSTRAINT "alerts_kind_check";--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_client_id_unique" ON "incidents" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "incidents_route_id_index" ON "incidents" USING btree ("route_id");--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_kind_check" CHECK ("alerts"."kind" IN ('other_adult_handover', 'mark_flagged', 'mark_conflict', 'authorization_conflict', 'absent_on_entrada', 'close_refused', 'incident'));--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE "incidents" FROM traslado_app;