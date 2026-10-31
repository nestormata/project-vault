-- Story 73.1 (D6): the browser-bound handoff nonce. handoff_nonces holds only HMAC(nonce) with a
-- 120 s expiry; no org_id and no RLS (no tenant is known at /auth/start). Same shape as
-- handoff_token_jti (0087): no explicit GRANT, vault_app gets its CRUD from the schema default
-- privileges. Additive only: dropping the retired handoff_pending_states table is a destructive
-- change that the guarded migrator refuses in place, so it waits for its own reviewed migration.
CREATE TABLE "handoff_nonces" (
	"nonce_hash" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_handoff_nonces_expires_at" ON "handoff_nonces" USING btree ("expires_at");