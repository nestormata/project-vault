-- Story 73.1 (D7): drop the retired prepare/confirm handoff state. Nothing reads or writes
-- handoff_pending_states since 73.1 removed the prepare/exchange-claim/confirm routes, and every
-- row expired within 120 s of being written. Nestor approved this destructive migration on
-- 2026-10-30; its KNOWN_REVIEWED_DESTRUCTIVE_MIGRATIONS entry lets the guarded migrator apply it
-- in place. No CASCADE: nothing depends on this table, and if something does the drop must fail.
DROP TABLE "handoff_pending_states";
