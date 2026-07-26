-- Story 14.4 Task 1: org_sso_domains — maps an email domain to the org+provider whose SSO
-- strategy the pre-auth domain-lookup route should route into (see sso-routes.ts's
-- domain-lookup handler / schema/org-sso-domains.ts).
--
-- org-scoped (RLS via the same NULLIF(current_setting(...)) pattern used by every other
-- org-scoped table, e.g. external_identities) even though the lookup itself happens pre-auth via
-- getAdminDb() — the same documented RLS/pre-auth-tension exception Story 14.3 established for
-- external_identities/project_invitations pre-auth lookups.
--
-- Unique index on domain alone: a domain can only ever route to one org/provider (Task 1.1,
-- epics.md's singular-mapping framing).
--
-- OPERATIONAL HAZARD (pre-mortem finding, no admin UI or domain-ownership verification exists
-- yet): because the unique index is on domain alone, mistakenly mapping a shared PUBLIC email
-- domain (gmail.com, outlook.com, etc.) to one org's SSO strategy would silently force every user
-- across every org whose email happens to end in that domain into one org's SSO flow, breaking
-- local login for everyone else who shares it. See schema/org-sso-domains.ts for the full note.
CREATE TABLE "org_sso_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"provider_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_sso_domains" ADD CONSTRAINT "org_sso_domains_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_org_sso_domains_domain" ON "org_sso_domains" USING btree ("domain");--> statement-breakpoint

ALTER TABLE org_sso_domains ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY org_sso_domains_isolation
  ON org_sso_domains
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
