-- Story 26.1: idempotency key for POST /api/v1/service/organizations (CM-tenant-to-PV-org
-- provisioning). Mirrors 0082_project_creation_idempotency.sql's exact shape: a nullable UUID
-- column + a partial unique index (WHERE ... IS NOT NULL) so rows that never went through this
-- endpoint (i.e. every pre-existing organization) never collide with each other or with a real
-- provisioning request id.
ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "service_provisioning_request_id" uuid;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_organizations_service_provisioning_request_id"
  ON "organizations" ("service_provisioning_request_id")
  WHERE "service_provisioning_request_id" IS NOT NULL;
