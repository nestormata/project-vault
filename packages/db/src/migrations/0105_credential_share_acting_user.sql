-- Story 65.6 D2 — record the acting human on host-created credential shares.
-- Additive and idempotent, like 0104: two columns on credential_shares plus an evidence-only backfill.
--   * acting_user_id: the validated human who acted through an extension (NULL = native row, or a
--     host row whose acting human is unknown). ON DELETE RESTRICT, same delete rule as shared_by.
--   * host_created: true for rows created through HostServices.credentialSharing. It is the only
--     thing separating "host row, human unknown" from a native row.
-- shared_by is NOT touched: it stays the NOT NULL FK and, for host rows, the machine user's
-- provisioning human. That keeps the previous app version working during a rolling deploy and keeps
-- audit attribution unchanged. Effective sharer = COALESCE(acting_user_id, shared_by).
--
-- BACKFILL (never guessed): host_created is set to true ONLY for rows whose credential.share_created
-- audit entry (audit_log_entries.resource_type = 'credential_share', resource_id = the share id) has
-- actor_type = 'machine_user'. acting_user_id stays NULL for them. Rows with no such evidence (purged
-- by retention, or created before the audit event existed) stay host_created = false and read back as
-- natively created.
--
-- RLS: credential_shares and audit_log_entries are org-scoped (FORCE RLS since 0070). The migration
-- role is the postgres superuser today (bypasses RLS) but guarded-migrate also accepts a
-- non-superuser, non-BYPASSRLS role, for which a plain cross-org UPDATE would match ZERO rows and
-- silently backfill nothing. The backfill therefore binds app.current_org_id per organization
-- (transaction-local, restored afterwards) so it is correct under either role.
--
-- ROLLING DEPLOY: the previous app version writes host rows without host_created, so they land as
-- false. The backfill is idempotent and only ever flips false -> true on audit evidence, so re-run
-- this statement (or deploy API instances atomically) once the old version is gone.
ALTER TABLE "credential_shares" ADD COLUMN IF NOT EXISTS "acting_user_id" uuid;--> statement-breakpoint
ALTER TABLE "credential_shares" ADD COLUMN IF NOT EXISTS "host_created" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'credential_shares_acting_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "credential_shares" ADD CONSTRAINT "credential_shares_acting_user_id_users_id_fk" FOREIGN KEY ("acting_user_id") REFERENCES "public"."users"("id") ON DELETE restrict;
  END IF;
END $$;--> statement-breakpoint
DO $$
DECLARE
  org_row record;
  previous_org text := COALESCE(current_setting('app.current_org_id', true), '');
BEGIN
  FOR org_row IN SELECT id FROM organizations LOOP
    PERFORM set_config('app.current_org_id', org_row.id::text, true);
    UPDATE credential_shares AS cs
       SET host_created = true
     WHERE cs.org_id = org_row.id
       AND cs.host_created = false
       AND EXISTS (
         SELECT 1
           FROM audit_log_entries AS ale
          WHERE ale.org_id = org_row.id
            AND ale.resource_type = 'credential_share'
            AND ale.resource_id = cs.id
            AND ale.event_type = 'credential.share_created'
            AND ale.actor_type = 'machine_user'
       );
  END LOOP;
  PERFORM set_config('app.current_org_id', previous_org, true);
END $$;
