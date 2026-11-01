CREATE TABLE "version_acknowledgements" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "version_acknowledgements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"plan_version_id" integer NOT NULL,
	"driver_id" integer NOT NULL,
	"session_id" integer NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "version_acknowledgements" ADD CONSTRAINT "version_acknowledgements_plan_version_id_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "version_acknowledgements" ADD CONSTRAINT "version_acknowledgements_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "version_acknowledgements" ADD CONSTRAINT "version_acknowledgements_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "version_acknowledgements_version_driver_unique" ON "version_acknowledgements" USING btree ("plan_version_id","driver_id");
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE "version_acknowledgements" FROM traslado_app;