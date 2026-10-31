CREATE TABLE "passenger_required_features" (
	"passenger_id" integer NOT NULL,
	"feature_id" integer NOT NULL,
	CONSTRAINT "passenger_required_features_passenger_id_feature_id_pk" PRIMARY KEY("passenger_id","feature_id")
);
--> statement-breakpoint
CREATE TABLE "passengers" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "passengers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"home_address" text NOT NULL,
	"home_latitude" double precision NOT NULL,
	"home_longitude" double precision NOT NULL,
	"access_notes" text,
	"companions" integer NOT NULL,
	"front_seat" boolean NOT NULL,
	"wheelchair" boolean NOT NULL,
	"max_ride_time_minutes" integer NOT NULL,
	"pickup_duration_minutes" integer NOT NULL,
	"dropoff_duration_minutes" integer NOT NULL,
	"medical_alert" text,
	"deactivated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "passengers_home_latitude_check" CHECK ("passengers"."home_latitude" BETWEEN -90 AND 90),
	CONSTRAINT "passengers_home_longitude_check" CHECK ("passengers"."home_longitude" BETWEEN -180 AND 180),
	CONSTRAINT "passengers_companions_check" CHECK ("passengers"."companions" BETWEEN 0 AND 2),
	CONSTRAINT "passengers_max_ride_time_positive" CHECK ("passengers"."max_ride_time_minutes" > 0),
	CONSTRAINT "passengers_pickup_duration_positive" CHECK ("passengers"."pickup_duration_minutes" > 0),
	CONSTRAINT "passengers_dropoff_duration_positive" CHECK ("passengers"."dropoff_duration_minutes" > 0),
	CONSTRAINT "passengers_medical_alert_length" CHECK (char_length("passengers"."medical_alert") <= 140)
);
--> statement-breakpoint
ALTER TABLE "passenger_required_features" ADD CONSTRAINT "passenger_required_features_passenger_id_passengers_id_fk" FOREIGN KEY ("passenger_id") REFERENCES "public"."passengers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passenger_required_features" ADD CONSTRAINT "passenger_required_features_feature_id_vehicle_features_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."vehicle_features"("id") ON DELETE restrict ON UPDATE no action;