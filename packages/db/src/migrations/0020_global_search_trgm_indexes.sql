CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_credentials_name_trgm" ON "credentials" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_credentials_description_trgm" ON "credentials" USING gin ("description" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_credentials_tags_trgm" ON "credentials" USING gin ((CAST("tags" AS text)) gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_projects_name_trgm" ON "projects" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_projects_tags_trgm" ON "projects" USING gin ((CAST("tags" AS text)) gin_trgm_ops);
