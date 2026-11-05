-- Story 43.30: browser-approved CLI sign-in grants. No RLS and no foreign keys: no tenant
-- is known when the CLI creates the row, and the poller is unauthenticated. Only HMAC hashes
-- of the codes are stored. Additive only.
CREATE TABLE "cli_device_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_code_hash" text NOT NULL,
	"user_code_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"interval_seconds" integer NOT NULL,
	"last_polled_at" timestamp with time zone,
	"client_name" text,
	"user_id" uuid,
	"org_id" uuid,
	"approver_session_id" uuid,
	"session_id" uuid,
	"step_up_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"denied_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "cli_device_grants_status_check" CHECK ("cli_device_grants"."status" in ('pending', 'approved', 'denied', 'consumed', 'revoked'))
);
--> statement-breakpoint
CREATE INDEX "idx_cli_device_grants_expires_at" ON "cli_device_grants" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_cli_device_grants_device_code_hash" ON "cli_device_grants" USING btree ("device_code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_cli_device_grants_user_code_hash" ON "cli_device_grants" USING btree ("user_code_hash");
