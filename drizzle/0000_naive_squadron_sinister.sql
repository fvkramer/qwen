CREATE EXTENSION IF NOT EXISTS citext;--> statement-breakpoint
CREATE TYPE "public"."message_kind" AS ENUM('intake', 'daily', 'confirm', 'system');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('queued', 'sent', 'delivered', 'bounced', 'complained', 'failed');--> statement-breakpoint
CREATE TYPE "public"."subscriber_status" AS ENUM('pending_confirm', 'active', 'paused', 'stopped', 'bounced');--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscriber_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"kind" "message_kind" NOT NULL,
	"day_number" integer,
	"subject" text,
	"body_text" text,
	"body_html" text,
	"provider_id" text,
	"message_id" text,
	"in_reply_to" text,
	"status" "message_status" DEFAULT 'queued' NOT NULL,
	"model" text,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"error" text,
	"scheduled_for" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"subscriber_id" uuid PRIMARY KEY NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"facts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"current_plan" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"in_reply_to_message_id" uuid,
	"from_email" text NOT NULL,
	"subject" text,
	"body_text" text NOT NULL,
	"raw" jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscribers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" "citext" NOT NULL,
	"status" "subscriber_status" DEFAULT 'pending_confirm' NOT NULL,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"send_hour_local" integer DEFAULT 6 NOT NULL,
	"send_minute_local" integer DEFAULT 30 NOT NULL,
	"confirm_token" text,
	"confirmed_at" timestamp with time zone,
	"day_number" integer DEFAULT 0 NOT NULL,
	"thread_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscribers_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_in_reply_to_message_id_messages_id_fk" FOREIGN KEY ("in_reply_to_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_created_idx" ON "events" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "messages_subscriber_created_idx" ON "messages" USING btree ("subscriber_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "messages_message_id_idx" ON "messages" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "replies_subscriber_created_idx" ON "replies" USING btree ("subscriber_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "subscribers_status_send_hour_idx" ON "subscribers" USING btree ("status","send_hour_local");