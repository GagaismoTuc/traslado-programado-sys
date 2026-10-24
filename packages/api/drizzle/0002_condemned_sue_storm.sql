CREATE TABLE "destinations" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "destinations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"address" text NOT NULL,
	"access_notes" text,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "destinations_kind_check" CHECK ("destinations"."kind" IN ('school', 'clinic', 'therapy', 'day_centre', 'other')),
	CONSTRAINT "destinations_latitude_check" CHECK ("destinations"."latitude" BETWEEN -90 AND 90),
	CONSTRAINT "destinations_longitude_check" CHECK ("destinations"."longitude" BETWEEN -180 AND 180)
);
