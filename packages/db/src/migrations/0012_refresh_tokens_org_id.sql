-- Migration 0012: Store org context on refresh tokens
-- Refresh tokens are identity-scoped, but the linked session row is RLS-protected.
-- Carrying org_id lets the auth service set the correct RLS context directly.

ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS org_id UUID;
--> statement-breakpoint
UPDATE refresh_tokens AS rt
SET org_id = s.org_id
FROM sessions AS s
WHERE rt.session_id = s.id
  AND rt.org_id IS NULL;
--> statement-breakpoint
ALTER TABLE refresh_tokens ALTER COLUMN org_id SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE refresh_tokens
    ADD CONSTRAINT refresh_tokens_org_id_organizations_id_fk
    FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_org_id
  ON refresh_tokens (org_id);
