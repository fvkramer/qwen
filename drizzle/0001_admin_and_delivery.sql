ALTER TABLE "subscribers" ADD COLUMN "hold_date" text;--> statement-breakpoint
CREATE INDEX "messages_provider_id_idx" ON "messages" USING btree ("provider_id");