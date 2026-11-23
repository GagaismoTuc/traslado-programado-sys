CREATE TABLE "positions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "positions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"route_id" integer NOT NULL,
	"driver_id" integer NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"accuracy_meters" double precision NOT NULL,
	"phone_time" timestamp with time zone NOT NULL,
	"server_time" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "positions_latitude_check" CHECK ("positions"."latitude" BETWEEN -90 AND 90),
	CONSTRAINT "positions_longitude_check" CHECK ("positions"."longitude" BETWEEN -180 AND 180),
	CONSTRAINT "positions_accuracy_check" CHECK ("positions"."accuracy_meters" >= 0 AND "positions"."accuracy_meters" < 'Infinity'::double precision)
);
--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "positions_route_phone_time_unique" ON "positions" USING btree ("route_id","phone_time");--> statement-breakpoint
CREATE INDEX "positions_server_time_index" ON "positions" USING btree ("server_time");--> statement-breakpoint
REVOKE UPDATE ON TABLE "positions" FROM traslado_app;