-- Story 56.2 AC1 — records every scheduled-task invocation ATTEMPT (success or failure/timeout)
-- so the missed-tick watchdog can detect "zero attempts across N expected ticks". Purely
-- additive: nullable, no default, no backfill; RLS/grants on the table are unchanged. Rows written
-- before this column existed are covered by the watchdog's COALESCE(last_attempt_at, last_run_at).
ALTER TABLE "extension_scheduled_task_runs" ADD COLUMN "last_attempt_at" timestamp with time zone;
