CREATE TABLE "remembered_devices" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "remembered_devices_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"session_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "remembered_devices_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "ended_reason" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "last_used_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "second_factor_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "persistent_session" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_secret" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_last_step" integer;--> statement-breakpoint
ALTER TABLE "remembered_devices" ADD CONSTRAINT "remembered_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remembered_devices" ADD CONSTRAINT "remembered_devices_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
UPDATE "sessions" SET "last_used_at" = "created_at";
