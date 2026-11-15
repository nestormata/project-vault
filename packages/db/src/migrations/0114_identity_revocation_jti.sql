-- Story 73.4 D5: identity_revocation_jti is the insert-first replay-burn ledger for
-- trusted-caller identity session-revocation JWTs. No org_id and no RLS (no tenant at verify
-- time), same shape as handoff_token_jti (0087). Cross-org identity lookup uses the admin
-- BYPASSRLS pool in application code (AC5), not a SECURITY DEFINER function.
CREATE TABLE "identity_revocation_jti" (
	"jti" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_revocation_jti_jti_len" CHECK (octet_length("identity_revocation_jti"."jti") BETWEEN 1 AND 128)
);
--> statement-breakpoint
CREATE INDEX "idx_identity_revocation_jti_expires_at" ON "identity_revocation_jti" USING btree ("expires_at");
