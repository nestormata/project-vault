-- Story 20.5 (review patch): backs up schema.ts's Zod-level `AttributeKeysSchema.min(1)` with a
-- real DB invariant — an explicit `attribute_keys = '{}'` is ambiguous ("named nothing" vs.
-- "whole-resource") and this table's other Story 20.5 invariants (`action`, `field_key`/
-- `attribute_keys` mutual exclusivity) are already double-enforced at the DB layer, not just Zod.
ALTER TABLE "credential_shares" ADD CONSTRAINT "credential_shares_attribute_keys_not_empty_check" CHECK ("credential_shares"."attribute_keys" IS NULL OR cardinality("credential_shares"."attribute_keys") > 0);
