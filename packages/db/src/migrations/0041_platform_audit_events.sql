-- Story 9.4: Platform Operator Audit Log.
--
-- Hand-authored (not `drizzle-kit generate`), matching the existing repo convention documented
-- in Story 4.3/5.1/9.1/9.2's Dev Notes. Style matches the SQL `drizzle-kit generate` itself
-- emits for the equivalent schema.ts definitions.

-- D1/D2: platform-level (whole-instance, not per-org) compliance-grade audit log for privileged
-- platform-operator actions. NO org_id column (D4) — not tenant-scoped. target_org_id/
-- target_user_id intentionally carry no FK constraint (AC-1 edge case): an audit trail must never
-- be blocked by, or cascade-deleted alongside, an org/user it merely references.
CREATE TABLE "platform_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"target_org_id" uuid,
	"target_user_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_address" text,
	"key_version" integer NOT NULL,
	"hmac" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_operator_id_users_id_fk"
  FOREIGN KEY ("operator_id") REFERENCES "users"("id");
--> statement-breakpoint
CREATE INDEX "idx_platform_audit_events_operator_created" ON "platform_audit_events" ("operator_id","created_at" DESC);
--> statement-breakpoint
CREATE INDEX "idx_platform_audit_events_action_type" ON "platform_audit_events" ("action_type","created_at" DESC);
--> statement-breakpoint
CREATE INDEX "idx_platform_audit_events_target_org" ON "platform_audit_events" ("target_org_id","created_at" DESC);
--> statement-breakpoint

-- D4: defense-in-depth RLS for a table with no org_id column — gated on a dedicated session
-- variable set (transaction-scoped, matching app.current_org_id's discipline exactly) only after
-- requirePlatformOperator() has already confirmed the caller is a verified platform operator.
ALTER TABLE "platform_audit_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "platform_audit_events_isolation" ON "platform_audit_events"
  USING (current_setting('app.platform_operator_verified', true) = 'true');
--> statement-breakpoint

-- D5: append-only enforcement — stronger than the platform_security_events precedent (grant-only)
-- because this table is the compliance-grade tamper-evidence log this story exists to create.
CREATE OR REPLACE FUNCTION prevent_platform_audit_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit_events is append-only: UPDATE and DELETE are forbidden';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER platform_audit_immutability
  BEFORE UPDATE OR DELETE ON platform_audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_platform_audit_mutation();
--> statement-breakpoint
-- Postgres checks grants before triggers — the REVOKE fires first in practice; both layers are
-- kept per the existing audit_log_entries/0001_rls_and_triggers.sql + 0002_audit_log_revoke.sql
-- precedent (a trigger alone is a single point of failure if a future migration drops it).
REVOKE UPDATE, DELETE ON platform_audit_events FROM vault_app;
--> statement-breakpoint

-- D8: maintenance-mode single-row state table (mirrors vault_state's single-row convention).
CREATE TABLE "platform_audit_maintenance_state" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"reason" text,
	"activated_by_user_id" uuid,
	"activated_at" timestamp with time zone,
	"deactivated_at" timestamp with time zone,
	CONSTRAINT "platform_audit_maintenance_state_single_row" CHECK ("platform_audit_maintenance_state"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "platform_audit_maintenance_state" ADD CONSTRAINT "platform_audit_maintenance_state_activated_by_user_id_users_id_fk"
  FOREIGN KEY ("activated_by_user_id") REFERENCES "users"("id");
--> statement-breakpoint
-- Bootstrap the singleton row so every read is a plain SELECT (no upsert-or-default dance
-- anywhere in application code) — mirrors vault_state's own "exactly one row, always present"
-- invariant.
INSERT INTO "platform_audit_maintenance_state" ("id", "active") VALUES (1, false)
  ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint

-- D8: FIFO staging table for platform-audit writes attempted while the log is unavailable AND
-- maintenance mode is active. sequence_num (own dedicated sequence, not a Drizzle serial column)
-- guarantees strictly increasing, gap-tolerant-but-never-duplicated drain ordering even under
-- concurrent writers (AC-19).
CREATE SEQUENCE IF NOT EXISTS "platform_audit_pending_seq";
--> statement-breakpoint
CREATE TABLE "platform_audit_pending_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intended_fields" jsonb NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sequence_num" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_platform_audit_pending_entries_sequence" ON "platform_audit_pending_entries" ("sequence_num");
--> statement-breakpoint

-- D3/AC-5: the platform audit key's own, independent rotation-lifecycle column — additive-only
-- (NOT NULL DEFAULT 1 backfills the single existing vault_state row automatically, AC-22).
ALTER TABLE "vault_state" ADD COLUMN "platform_audit_key_version" integer DEFAULT 1 NOT NULL;
