-- Story 20.5 (Scoped/Bounded Sharing Contract, decided by Story 20.4 in architecture.md):
-- generalizes `credential_shares.field_key` into `attribute_keys` without narrowing its existing
-- behavior — `field_key` is untouched and remains fully authoritative for existing (Epic 17) call
-- paths. `attribute_keys` NULL defers to `field_key` (or, if that is also NULL, is a whole-resource
-- share subject to sensitivity-default-exclusion at serialization time — no backfill/reclassifying
-- of existing rows here, the rule is applied going forward at read time). A non-null array is an
-- explicit allow-list of attribute/field keys. `action` persists `BoundedShareScope.action`
-- (`'read'` only in this contract version) and is enforced by a check constraint, not just Zod.
ALTER TABLE "credential_shares" ADD COLUMN "attribute_keys" text[];--> statement-breakpoint
ALTER TABLE "credential_shares" ADD COLUMN "action" text DEFAULT 'read' NOT NULL;--> statement-breakpoint
ALTER TABLE "credential_shares" ADD CONSTRAINT "credential_shares_action_check" CHECK ("credential_shares"."action" IN ('read'));--> statement-breakpoint
-- Bugfix (post-implementation review): backs up the Zod-level `rejectBothFieldKeyAndAttributeKeys`
-- `.refine` (schema.ts) with a real DB invariant — `field_key` and `attribute_keys` must never both
-- be non-null on the same row, regardless of write path.
ALTER TABLE "credential_shares" ADD CONSTRAINT "credential_shares_field_key_attribute_keys_check" CHECK (NOT ("credential_shares"."field_key" IS NOT NULL AND "credential_shares"."attribute_keys" IS NOT NULL));
