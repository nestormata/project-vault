-- Story 40.1 — extension request-state peek/consume table (see
-- `packages/db/src/schema/extension-request-states.ts` for full rationale). Deliberately no RLS
-- and no FKs (documented exception in `check-rls-coverage.ts`) — `org_id`/`identity_id` (AC12)
-- are enforced by explicit `WHERE` filters in `apps/api/src/lib/extension-pending-state.ts`'s
-- peek/consume helpers, not by a session-var-driven RLS policy.
CREATE TABLE "extension_request_states" (
	"id" text PRIMARY KEY NOT NULL,
	"cookie_hash" text NOT NULL,
	"extension_name" text NOT NULL,
	"org_id" text NOT NULL,
	"identity_id" text NOT NULL,
	"state_json" text NOT NULL,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extension_request_states_cookie_hash_unique" UNIQUE("cookie_hash")
);
--> statement-breakpoint
CREATE INDEX "idx_extension_request_states_expires_at" ON "extension_request_states" USING btree ("expires_at");