-- Story 73.4 D5/D3: identity_revocation_jti is the insert-first replay-burn ledger for
-- trusted-caller identity session-revocation JWTs. No org_id and no RLS (no tenant at verify
-- time), same shape as handoff_token_jti (0087). lookup_external_identities_by_subject is a
-- SECURITY DEFINER read of (provider_name, external_subject) so vault_app can resolve matching
-- users across orgs inside one RLS-bound transaction.
CREATE TABLE "identity_revocation_jti" (
	"jti" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_revocation_jti_jti_len" CHECK (octet_length("identity_revocation_jti"."jti") BETWEEN 1 AND 128)
);
--> statement-breakpoint
CREATE INDEX "idx_identity_revocation_jti_expires_at" ON "identity_revocation_jti" USING btree ("expires_at");--> statement-breakpoint
CREATE FUNCTION lookup_external_identities_by_subject(p_provider text, p_subject text)
RETURNS TABLE(user_id uuid, org_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT user_id, org_id
  FROM external_identities
  WHERE provider_name = p_provider AND external_subject = p_subject
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION lookup_external_identities_by_subject(text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION lookup_external_identities_by_subject(text, text) TO vault_app;
