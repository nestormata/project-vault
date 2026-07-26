ALTER TABLE "credential_dependencies" ADD COLUMN "link_url" text;
--> statement-breakpoint
ALTER TABLE "credential_dependencies" ADD CONSTRAINT "credential_dependencies_link_url_len_check"
  CHECK ("link_url" IS NULL OR char_length("link_url") <= 2048);
