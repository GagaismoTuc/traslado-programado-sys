CREATE TABLE "drivers" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "drivers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"home_address" text NOT NULL,
	"home_latitude" double precision NOT NULL,
	"home_longitude" double precision NOT NULL,
	"usual_vehicle_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drivers_home_latitude_check" CHECK ("drivers"."home_latitude" BETWEEN -90 AND 90),
	CONSTRAINT "drivers_home_longitude_check" CHECK ("drivers"."home_longitude" BETWEEN -180 AND 180)
);
--> statement-breakpoint
CREATE TABLE "vehicle_feature_assignments" (
	"vehicle_id" integer NOT NULL,
	"feature_id" integer NOT NULL,
	CONSTRAINT "vehicle_feature_assignments_vehicle_id_feature_id_pk" PRIMARY KEY("vehicle_id","feature_id")
);
--> statement-breakpoint
CREATE TABLE "vehicle_features" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vehicle_features_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vehicles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"plate" text NOT NULL,
	"model" text NOT NULL,
	"seats" integer NOT NULL,
	"front_seats" integer DEFAULT 1 NOT NULL,
	"deactivated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vehicles_seats_positive" CHECK ("vehicles"."seats" > 0),
	CONSTRAINT "vehicles_front_seats_check" CHECK ("vehicles"."front_seats" = 1)
);
--> statement-breakpoint
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_usual_vehicle_id_vehicles_id_fk" FOREIGN KEY ("usual_vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_feature_assignments" ADD CONSTRAINT "vehicle_feature_assignments_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_feature_assignments" ADD CONSTRAINT "vehicle_feature_assignments_feature_id_vehicle_features_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."vehicle_features"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "drivers_user_id_unique" ON "drivers" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_features_name_lower_unique" ON "vehicle_features" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "vehicles_active_plate_unique" ON "vehicles" USING btree (upper("plate")) WHERE "vehicles"."deactivated_at" IS NULL;