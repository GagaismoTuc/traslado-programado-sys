ALTER TABLE "marks" DROP CONSTRAINT "marks_receiver_kind_check";--> statement-breakpoint
ALTER TABLE "marks" ADD COLUMN "receiver_driver_id" integer;--> statement-breakpoint
ALTER TABLE "marks" ADD COLUMN "trasbordo_mark_id" integer;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "chained_from_transfer_id" integer;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "trasbordo_stop" text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "trasbordo_latitude" double precision;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "trasbordo_longitude" double precision;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "trasbordo_time" time;--> statement-breakpoint
ALTER TABLE "marks" ADD CONSTRAINT "marks_receiver_driver_id_drivers_id_fk" FOREIGN KEY ("receiver_driver_id") REFERENCES "public"."drivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marks" ADD CONSTRAINT "marks_trasbordo_mark_id_marks_id_fk" FOREIGN KEY ("trasbordo_mark_id") REFERENCES "public"."marks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_chained_from_transfer_id_transfers_id_fk" FOREIGN KEY ("chained_from_transfer_id") REFERENCES "public"."transfers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transfers_chained_from_unique" ON "transfers" USING btree ("chained_from_transfer_id");--> statement-breakpoint
ALTER TABLE "marks" ADD CONSTRAINT "marks_receiver_driver_check" CHECK (("marks"."receiver_kind" = 'driver') = ("marks"."receiver_driver_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "marks" ADD CONSTRAINT "marks_trasbordo_mark_check" CHECK ("marks"."trasbordo_mark_id" IS NULL OR "marks"."kind" = 'subio');--> statement-breakpoint
ALTER TABLE "marks" ADD CONSTRAINT "marks_receiver_kind_check" CHECK ("marks"."receiver_kind" IS NULL
      OR ("marks"."receiver_kind" = 'authorized_adult' AND "marks"."receiver_adult_id" IS NOT NULL AND "marks"."receiver_destination_id" IS NULL
        AND "marks"."receiver_name" IS NULL AND "marks"."receiver_dni" IS NULL AND "marks"."authorization_id" IS NULL)
      OR ("marks"."receiver_kind" = 'destination' AND "marks"."receiver_destination_id" IS NOT NULL AND "marks"."receiver_adult_id" IS NULL
        AND "marks"."receiver_name" IS NULL AND "marks"."receiver_dni" IS NULL AND "marks"."authorization_id" IS NULL)
      OR ("marks"."receiver_kind" = 'other_adult' AND "marks"."receiver_name" IS NOT NULL AND "marks"."receiver_dni" IS NOT NULL
        AND "marks"."receiver_adult_id" IS NULL AND "marks"."receiver_destination_id" IS NULL)
      OR ("marks"."receiver_kind" IN ('base_staff', 'driver') AND "marks"."receiver_adult_id" IS NULL AND "marks"."receiver_destination_id" IS NULL
        AND "marks"."receiver_name" IS NULL AND "marks"."receiver_dni" IS NULL AND "marks"."authorization_id" IS NULL));--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_trasbordo_check" CHECK (("transfers"."trasbordo_stop" IS NULL AND "transfers"."trasbordo_latitude" IS NULL AND "transfers"."trasbordo_longitude" IS NULL AND "transfers"."trasbordo_time" IS NULL)
      OR ("transfers"."trasbordo_stop" IN ('pickup', 'dropoff') AND "transfers"."trasbordo_latitude" BETWEEN -90 AND 90
        AND "transfers"."trasbordo_longitude" BETWEEN -180 AND 180 AND "transfers"."trasbordo_time" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_chain_check" CHECK ("transfers"."chained_from_transfer_id" IS NULL OR "transfers"."trasbordo_stop" = 'pickup');