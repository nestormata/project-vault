ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "creation_request_id" uuid;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_projects_creation_request_id"
  ON "projects" ("creation_request_id")
  WHERE "creation_request_id" IS NOT NULL;
