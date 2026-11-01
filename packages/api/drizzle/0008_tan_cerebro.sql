ALTER TABLE "destinations" ADD COLUMN "arrival_tolerance_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "start_kind" text;--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "start_latitude" double precision;--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "start_longitude" double precision;--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "end_kind" text;--> statement-breakpoint
ALTER TABLE "stops" ADD COLUMN "planned_time" time;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "exit_time" time;--> statement-breakpoint
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_arrival_tolerance_check" CHECK ("destinations"."arrival_tolerance_minutes" BETWEEN 0 AND 240);--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_start_kind_check" CHECK ("routes"."start_kind" IN ('home', 'previous', 'point'));--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_start_point_check" CHECK (("routes"."start_kind" = 'point' AND "routes"."start_latitude" BETWEEN -90 AND 90 AND "routes"."start_longitude" BETWEEN -180 AND 180)
      OR ("routes"."start_kind" IS DISTINCT FROM 'point' AND "routes"."start_latitude" IS NULL AND "routes"."start_longitude" IS NULL));--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_end_kind_check" CHECK ("routes"."end_kind" IN ('home', 'open'));--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_exit_time_check" CHECK ("transfers"."exit_time" IS NULL OR ("transfers"."origin_destination_id" IS NOT NULL AND "transfers"."exit_time" < "transfers"."target_time"));--> statement-breakpoint
-- Tolerancia de llegada of existing Destinos from their kind: schools and day centres half an hour, the rest none.
UPDATE "destinations" SET "arrival_tolerance_minutes" = 30 WHERE "kind" IN ('school', 'day_centre');