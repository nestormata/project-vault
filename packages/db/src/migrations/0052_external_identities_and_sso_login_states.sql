-- Story 14.3 Task 1/Task 2: external_identities (org-scoped SSO identity binding) and
-- sso_login_states (pre-auth CSRF-style state for the SSO start/callback round trip).
--
-- external_identities: org-scoped (RLS via the same NULLIF(current_setting(...)) pattern used by
-- every other org-scoped table). Unique index on (org_id, provider_name, external_subject) is the
-- exact lookup key AC-5/AC-7's session-issuing/rejection branches key off of, and the same index
-- backs AC-10's duplicate-link 409 test (unique violation, not a silent overwrite).
--
-- sso_login_states: deliberately NOT org-scoped and has NO RLS policy (see check-rls-coverage.ts's
-- EXCLUDED_TABLES entry) — the caller is unauthenticated at state-mint time and no org is known
-- yet. state_hash stores an HMAC-SHA256 of the raw cookie value only, mirroring
-- refresh_tokens.tokenHash's existing hashing precedent (never a raw, queryable secret).
CREATE TABLE "external_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_name" text NOT NULL,
	"external_subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_login_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state_hash" text NOT NULL,
	"provider_name" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_login_states_state_hash_unique" UNIQUE("state_hash")
);
--> statement-breakpoint
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_identities_org_provider_subject" ON "external_identities" USING btree ("org_id","provider_name","external_subject");--> statement-breakpoint

ALTER TABLE external_identities ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY external_identities_isolation
  ON external_identities
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
