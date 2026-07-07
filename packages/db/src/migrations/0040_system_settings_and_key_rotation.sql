-- Story 9.2 D3/D8: system_settings singleton table + vault_state.key_rotated_at.
--
-- Hand-authored (not `drizzle-kit generate`), matching the existing repo convention documented
-- in Story 4.3/5.1/9.1's Dev Notes. Style matches the SQL `drizzle-kit generate` itself emits
-- for the equivalent schema.ts definitions.

-- D3/AC-7: system_settings — a new platform-level (non-org-scoped, RLS-exempt) singleton table.
-- The table starts EMPTY (AC-24) — a row is only ever created by the first `PUT
-- /admin/settings` upsert. Do NOT add an INSERT here; GET synthesizes defaults from env vars
-- when no row exists yet (D3's resolveEffectiveSettings() precedence rule).
CREATE TABLE "system_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"smtp_host" text,
	"smtp_port" integer,
	"smtp_secure" boolean,
	"smtp_user" text,
	"smtp_pass_encrypted" jsonb,
	"smtp_from" text,
	"backup_schedule_override" text,
	"backup_retention_count_override" integer,
	"default_slack_webhook_url" text,
	"max_orgs" integer DEFAULT 10 NOT NULL,
	"max_users_per_org" integer DEFAULT 50 NOT NULL,
	"session_idle_timeout_minutes_override" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "system_settings_single_row" CHECK ("system_settings"."id" = 1)
);
--> statement-breakpoint

-- D8/AC-7/AC-20: master-key custody age trigger needs a rotation timestamp — none existed before
-- this story. Nullable at the schema level, but immediately backfilled below so it is never
-- actually NULL in practice after this migration runs.
ALTER TABLE "vault_state" ADD COLUMN "key_rotated_at" timestamp with time zone;
--> statement-breakpoint

-- D8/AC-7: backfill every existing vault_state row (there is exactly one, id=1) to its own
-- initialized_at — an honest "age since last *recorded* rotation, defaulting to init time"
-- starting point (D8's documented v1 limitation: no rotation-execution endpoint exists yet, so
-- this value never advances until a future story adds one).
--
-- vault_state's append-only trigger (0003_vault_state.sql, Red Team hardening) blocks ALL
-- UPDATE/DELETE statements against this table, including from a migration running as the
-- postgres superuser — there is no role-based bypass, only a test-only session GUC. A
-- migration is a legitimate, one-time, schema-level exception (unlike a runtime application
-- write, which must never be able to alter encrypted_sentinel), so this bracket disables/
-- re-enables the trigger for the duration of the backfill rather than reusing the test-only GUC.
ALTER TABLE "vault_state" DISABLE TRIGGER "vault_state_no_update";
UPDATE "vault_state" SET "key_rotated_at" = "initialized_at" WHERE "key_rotated_at" IS NULL;
ALTER TABLE "vault_state" ENABLE TRIGGER "vault_state_no_update";
