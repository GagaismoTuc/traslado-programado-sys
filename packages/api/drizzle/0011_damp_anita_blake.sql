CREATE TABLE "documents" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "documents_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vehicle_id" integer,
	"driver_id" integer,
	"name" text NOT NULL,
	"expires_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_one_owner_check" CHECK (("documents"."vehicle_id" IS NULL) <> ("documents"."driver_id" IS NULL)),
	CONSTRAINT "documents_name_check" CHECK (btrim("documents"."name") <> '')
);
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_vehicle_name_unique" ON "documents" USING btree ("vehicle_id",lower("name")) WHERE "documents"."vehicle_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_driver_name_unique" ON "documents" USING btree ("driver_id",lower("name")) WHERE "documents"."driver_id" IS NOT NULL;