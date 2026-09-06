-- Story 1.25 (HIGH finding, chain-link audit HMACs so a deleted row breaks verification): adds
-- previous_entry_hmac + chain_seq to both audit_log_entries and platform_audit_events so
-- verify.ts can walk the chain and detect an interior row deletion that would otherwise leave
-- every surviving row's own HMAC still self-consistent.
--
-- Migration-safety note (Task 1 "Dev Notes: Migration performance/locking risk"): a single
-- `ADD COLUMN chain_seq bigint NOT NULL GENERATED ALWAYS AS IDENTITY` statement is refused
-- outright by this project's own `guarded-migrate.ts` (Story 9.3 D1/D2) as a destructive
-- `ADD COLUMN ... NOT NULL (no DEFAULT)` operation — confirmed directly against this repo's
-- migration-safety guard while authoring this migration, not merely assumed. That guard exists
-- for exactly the reason Dev Notes flags: populating a NOT NULL identity column for every
-- existing row can require an ACCESS EXCLUSIVE lock for the full duration of the backfill on a
-- large, long-lived audit_log_entries table, which would be a real, user-visible outage risk on
-- a self-hosted deployment. This migration instead uses the lower-risk staged sequence Dev Notes
-- recommends: add both new columns as nullable (fast, metadata-only), backfill in ordinary
-- UPDATE statements, only then enforce NOT NULL (cheap once no NULLs remain), and finally convert
-- the column to a true GENERATED ALWAYS AS IDENTITY (metadata-only — creates the backing
-- sequence and marks the column without rewriting existing row data).
--> statement-breakpoint

-- Step 1: add both new columns as nullable, no default, on both tables.
ALTER TABLE "audit_log_entries" ADD COLUMN "previous_entry_hmac" text;--> statement-breakpoint
ALTER TABLE "audit_log_entries" ADD COLUMN "chain_seq" bigint;--> statement-breakpoint
ALTER TABLE "platform_audit_events" ADD COLUMN "previous_entry_hmac" text;--> statement-breakpoint
ALTER TABLE "platform_audit_events" ADD COLUMN "chain_seq" bigint;--> statement-breakpoint

-- Step 2 (AC-5): backfill chain_seq for every existing row in the best-available approximation
-- of true historical insertion order. `created_at` is the ordering key used here for
-- PRE-MIGRATION rows only — chain_seq itself becomes the actual source of truth for insertion
-- order going forward (see the schema files' own comments on why `created_at` alone is unsafe
-- for platform_audit_events specifically, once the maintenance-mode drain path can insert a row
-- with an earlier explicit createdAt than its real insertion time). `id` is a tiebreaker only,
-- for the rare case of two rows sharing an identical `created_at` timestamp — true sub-timestamp
-- insertion order cannot be recovered for historical rows written before this column existed.
-- One global sequence per table (chain_seq is NOT per-org for audit_log_entries — the per-org
-- chain is expressed by filtering on org_id when reading it back, not by a per-org counter).
UPDATE "audit_log_entries" a
   SET "chain_seq" = ranked.rn
  FROM (
    SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn FROM "audit_log_entries"
  ) ranked
 WHERE a.id = ranked.id;--> statement-breakpoint

UPDATE "platform_audit_events" a
   SET "chain_seq" = ranked.rn
  FROM (
    SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn FROM "platform_audit_events"
  ) ranked
 WHERE a.id = ranked.id;--> statement-breakpoint

-- Step 3 (AC-5): backfill previous_entry_hmac as the actual prior row's hmac, by chain_seq order
-- — a real, verifiable link, even though it was never folded into that prior row's own hmac
-- digest (computed before this story existed). verify.ts's chain-link check compares the stored
-- previous_entry_hmac to the prior row's actual hmac independently of what went into either
-- row's own hmac digest, so this backfill retroactively closes the delete-detection gap for
-- historical rows WITHOUT rewriting the immutable hmac column. LAG()'s own boundary behavior
-- correctly leaves the lowest chain_seq per chain (per org_id for audit_log_entries; overall for
-- platform_audit_events) as NULL — the true genesis row.
UPDATE "audit_log_entries" a
   SET "previous_entry_hmac" = prev.prior_hmac
  FROM (
    SELECT id, LAG(hmac) OVER (PARTITION BY org_id ORDER BY chain_seq) AS prior_hmac
    FROM "audit_log_entries"
  ) prev
 WHERE a.id = prev.id;--> statement-breakpoint

UPDATE "platform_audit_events" a
   SET "previous_entry_hmac" = prev.prior_hmac
  FROM (
    SELECT id, LAG(hmac) OVER (ORDER BY chain_seq) AS prior_hmac
    FROM "platform_audit_events"
  ) prev
 WHERE a.id = prev.id;--> statement-breakpoint

-- Step 4: now that every row has a chain_seq value, enforce NOT NULL. Excluded from this
-- project's "ADD COLUMN ... NOT NULL (no DEFAULT)" destructive-migration pattern by design (no
-- ADD COLUMN keyword present) and cheap once no NULLs remain — Postgres only has to verify the
-- constraint, not rewrite the table.
ALTER TABLE "audit_log_entries" ALTER COLUMN "chain_seq" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_audit_events" ALTER COLUMN "chain_seq" SET NOT NULL;--> statement-breakpoint

-- Step 5 (AC-1): convert the now-fully-populated column into a true GENERATED ALWAYS AS IDENTITY
-- column — this is what makes it impossible for application code to set chain_seq explicitly
-- (Postgres rejects a plain INSERT/UPDATE naming this column without OVERRIDING SYSTEM VALUE),
-- the property this story relies on for chain_seq to be trustworthy as an ordering key. Adding
-- GENERATED ALWAYS AS IDENTITY to an already-populated, already-NOT-NULL column is
-- metadata-only: it creates the backing sequence and marks the column, it does not rewrite
-- existing row data. RESTART past the highest backfilled value so the first
-- application-driven insert continues the sequence correctly with no collision.
DO $$
DECLARE
  v_next_audit bigint;
  v_next_platform bigint;
BEGIN
  SELECT COALESCE(MAX(chain_seq), 0) + 1 INTO v_next_audit FROM "audit_log_entries";
  EXECUTE format(
    'ALTER TABLE "audit_log_entries" ALTER COLUMN "chain_seq" ADD GENERATED ALWAYS AS IDENTITY (START WITH %s)',
    v_next_audit
  );

  SELECT COALESCE(MAX(chain_seq), 0) + 1 INTO v_next_platform FROM "platform_audit_events";
  EXECUTE format(
    'ALTER TABLE "platform_audit_events" ALTER COLUMN "chain_seq" ADD GENERATED ALWAYS AS IDENTITY (START WITH %s)',
    v_next_platform
  );
END $$;--> statement-breakpoint

-- Step 6 (AC-1): chain_seq must be unique (a bare GENERATED ALWAYS AS IDENTITY column is not
-- implicitly unique unless it is also the primary key) — also serves as the ordering index for
-- verify.ts's chain walk.
CREATE UNIQUE INDEX "idx_audit_log_entries_chain_seq" ON "audit_log_entries" USING btree ("chain_seq");--> statement-breakpoint
CREATE INDEX "idx_audit_log_entries_org_chain_seq" ON "audit_log_entries" USING btree ("org_id","chain_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_platform_audit_events_chain_seq" ON "platform_audit_events" USING btree ("chain_seq");
