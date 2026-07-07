-- Story 9.1 D1/D3: platform-operator authorization primitive + two new platform-level
-- (non-org-scoped, RLS-exempt) tables for encrypted backup/restore.
--
-- Hand-authored (not `drizzle-kit generate`, per the existing repo convention documented in
-- Story 4.3/5.1's Dev Notes: the meta/*_snapshot.json chain has gaps for several earlier
-- hand-authored migrations, so `generate` would misfire a stale diff). Style matches the SQL
-- `drizzle-kit generate` itself emits for the equivalent schema.ts definitions.

-- D1/AC-3: existing rows get the column default (false) — no existing user is retroactively
-- granted platform-operator access by this migration. Do NOT add any `UPDATE users SET
-- is_platform_operator = true WHERE ...` heuristic here — see AC-3's negative example.
ALTER TABLE "users" ADD COLUMN "is_platform_operator" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

-- D1/AC-1: TOCTOU-safe single-winner bootstrap guard. Indexing a constant expression `(true)`
-- for every row that satisfies `WHERE is_platform_operator = true` means at most one such row can
-- ever exist — a second concurrent registration's insert attempt raises a unique violation on
-- this index, which apps/api/src/modules/auth/service.ts catches and retries as an ordinary
-- (non-operator) registration instead of failing the request outright.
CREATE UNIQUE INDEX "idx_users_one_platform_operator" ON "users" ((true)) WHERE "users"."is_platform_operator" = true;
--> statement-breakpoint

-- D3: backup_runs — source of truth for backup history, health monitoring, and GET
-- /admin/backups. Platform-level (whole-instance, D2) — no org_id column, added to
-- check-rls-coverage.ts's EXCLUDED_TABLES in this same migration.
CREATE TABLE "backup_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"filename" text NOT NULL UNIQUE,
	"status" text DEFAULT 'running' NOT NULL,
	"triggered_by" text NOT NULL,
	"triggered_by_user_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"size_bytes" bigint,
	"key_version" integer,
	"checksum_sha256" text,
	"verified" text DEFAULT 'unverified' NOT NULL,
	"error_message" text,
	CONSTRAINT "backup_runs_status_check" CHECK ("backup_runs"."status" IN ('running','succeeded','failed')),
	CONSTRAINT "backup_runs_triggered_by_check" CHECK ("backup_runs"."triggered_by" IN ('schedule','manual')),
	CONSTRAINT "backup_runs_verified_check" CHECK ("backup_runs"."verified" IN ('unverified','valid','invalid'))
);
--> statement-breakpoint

-- D3: admin_alerts — platform-level alert table (distinct from org-scoped monitoring_alerts /
-- security_alerts), used for backup.missed / backup.failure here and explicitly reserved for
-- Story 9.2's key_custody_risk alert.
CREATE TABLE "admin_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_type" text NOT NULL,
	"severity" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	CONSTRAINT "admin_alerts_severity_check" CHECK ("admin_alerts"."severity" IN ('info','warning','critical')),
	CONSTRAINT "admin_alerts_status_check" CHECK ("admin_alerts"."status" IN ('active','acknowledged','dismissed'))
);
--> statement-breakpoint

CREATE INDEX "idx_admin_alerts_type_status" ON "admin_alerts" USING btree ("alert_type","status");
