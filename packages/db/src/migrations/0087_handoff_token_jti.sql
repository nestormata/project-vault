-- Story 30.2 Task 1/Task 2 (DW-128): handoff_token_jti (durable insert-first replay-burn ledger
-- for CentralizeMe-issued handoff tokens — the jti primary key IS the replay-burn mechanism, no
-- SELECT-then-INSERT, no user_id/org_id FK, no RLS) and handoff_pending_states (prepare-time
-- pending-handoff record consumed by the confirm route). Both deliberately follow
-- sso_login_states/platform_security_events' no-FK/no-RLS shape — no tenant is known/trusted at
-- ingestion time. See packages/db/src/schema/handoff-token-jti.ts and
-- packages/db/src/schema/handoff-pending-states.ts for full rationale.
CREATE TABLE "handoff_token_jti" (
	"jti" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "handoff_pending_states" (
	"id" text PRIMARY KEY NOT NULL,
	"cookie_hash" text NOT NULL,
	"jti" text NOT NULL,
	"provider_name" text NOT NULL,
	"external_subject" text NOT NULL,
	"organization_id" text NOT NULL,
	"email" text,
	"display_name" text,
	"claims_version" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "handoff_pending_states_cookie_hash_unique" UNIQUE("cookie_hash")
);
--> statement-breakpoint
CREATE INDEX "idx_handoff_token_jti_expires_at" ON "handoff_token_jti" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_handoff_pending_states_expires_at" ON "handoff_pending_states" USING btree ("expires_at");