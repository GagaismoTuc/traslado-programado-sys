CREATE TABLE "authorized_adults" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "authorized_adults_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"passenger_id" integer NOT NULL,
	"name" text NOT NULL,
	"dni" text NOT NULL,
	"relation" text NOT NULL,
	"phone" text NOT NULL,
	"legal_guardian" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authorized_adults_id_passenger_unique" UNIQUE("id","passenger_id")
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"passenger_id" integer PRIMARY KEY NOT NULL,
	"signed_by_adult_id" integer NOT NULL,
	"signed_at" date NOT NULL,
	"other_adult_allowed" boolean NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "authorized_adults" ADD CONSTRAINT "authorized_adults_passenger_id_passengers_id_fk" FOREIGN KEY ("passenger_id") REFERENCES "public"."passengers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_passenger_id_passengers_id_fk" FOREIGN KEY ("passenger_id") REFERENCES "public"."passengers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_signed_by_adult_fk" FOREIGN KEY ("signed_by_adult_id","passenger_id") REFERENCES "public"."authorized_adults"("id","passenger_id") ON DELETE restrict ON UPDATE no action;