ALTER TABLE "projects" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_credentials_project_expires" ON "credentials" USING btree ("project_id","expires_at");
