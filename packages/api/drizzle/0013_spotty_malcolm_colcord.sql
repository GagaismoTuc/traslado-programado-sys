ALTER TABLE "marks" DROP CONSTRAINT "marks_kind_check";--> statement-breakpoint
ALTER TABLE "marks" ALTER COLUMN "driver_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "marks" ADD COLUMN "corrects_mark_id" integer;--> statement-breakpoint
ALTER TABLE "marks" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "marks" ADD CONSTRAINT "marks_corrects_mark_id_marks_id_fk" FOREIGN KEY ("corrects_mark_id") REFERENCES "public"."marks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "marks_corrects_mark_id_index" ON "marks" USING btree ("corrects_mark_id");--> statement-breakpoint
ALTER TABLE "marks" ADD CONSTRAINT "marks_undo_check" CHECK ("marks"."kind" <> 'undo' OR "marks"."corrects_mark_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "marks" ADD CONSTRAINT "marks_reason_check" CHECK ("marks"."reason" IS NULL OR "marks"."corrects_mark_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "marks" ADD CONSTRAINT "marks_office_correction_check" CHECK ("marks"."driver_id" IS NOT NULL OR "marks"."reason" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "marks" ADD CONSTRAINT "marks_kind_check" CHECK ("marks"."kind" IN ('subio', 'ausente', 'entregado', 'undo'));