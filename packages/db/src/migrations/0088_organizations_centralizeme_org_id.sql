-- Story 30.2 (org-mismatch critical-bug fix): CentralizeMe's own organizationId claim (a
-- WorkOS-directory-shaped identifier, e.g. "org_synthetic_acme") is never PV's own org UUID — PV
-- had no stored value to compare a handoff token's `organizationId` claim against. Mirrors
-- 0083_service_provisioning_requests.sql's exact shape: a nullable text column + a partial unique
-- index (WHERE ... IS NOT NULL) so pre-existing organizations, and any organization provisioned
-- before CM's provisioning client is updated to send this field (deferred — see
-- deferred-work.md), never collide with each other or with a real CM organizationId.
ALTER TABLE "organizations" ADD COLUMN "centralizeme_organization_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_organizations_centralizeme_organization_id" ON "organizations" USING btree ("centralizeme_organization_id") WHERE "organizations"."centralizeme_organization_id" IS NOT NULL;