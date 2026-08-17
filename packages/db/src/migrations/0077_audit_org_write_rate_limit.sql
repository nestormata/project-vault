-- Story 22.2 AC-2 — per-org write-rate limiting (throughput axis), colocated on the ALREADY
-- RLS-protected audit_org_storage_usage row (no new table — Story 22.1's finding H6 rejected an
-- unprotected rate-bucket table) and a new override column on the already-existing
-- audit_storage_quota_config row. No new RLS policy is required or added: both existing FOR ALL
-- ... USING ... WITH CHECK policies (migration 0075) are row-level, not column-level, and already
-- cover every column on the row, including these seven.
ALTER TABLE "audit_storage_quota_config" ADD COLUMN "write_rate_per_minute" bigint;--> statement-breakpoint
ALTER TABLE "audit_org_storage_usage" ADD COLUMN "rate_window_count" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_org_storage_usage" ADD COLUMN "rate_window_reset_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "audit_org_storage_usage" ADD COLUMN "preauth_rate_window_count" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_org_storage_usage" ADD COLUMN "preauth_rate_window_reset_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "audit_org_storage_usage" ADD COLUMN "rate_refused_count" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_org_storage_usage" ADD COLUMN "last_rate_refusal_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "audit_storage_quota_config" ADD CONSTRAINT "audit_storage_quota_config_write_rate_per_minute_positive" CHECK ("audit_storage_quota_config"."write_rate_per_minute" > 0);--> statement-breakpoint
ALTER TABLE "audit_org_storage_usage" ADD CONSTRAINT "audit_org_storage_usage_rate_window_count_non_negative" CHECK ("audit_org_storage_usage"."rate_window_count" >= 0);--> statement-breakpoint
ALTER TABLE "audit_org_storage_usage" ADD CONSTRAINT "audit_org_storage_usage_preauth_rate_window_count_non_negative" CHECK ("audit_org_storage_usage"."preauth_rate_window_count" >= 0);