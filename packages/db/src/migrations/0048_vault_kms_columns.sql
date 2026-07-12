-- Story 1.14: adds the two columns needed to implement the schema-reserved 'kms' unseal mode.
-- Purely additive — both columns are nullable, no default, no backfill of existing rows.
-- AC-7: kms_key_id/kms_encrypted_dek remain NULL for every non-'kms'-mode row, before and after.
-- A DB-level CHECK enforcing "kms_encrypted_dek IS NOT NULL when kms_type='kms'" is deliberately
-- deferred (AC-7 negative example) to avoid coupling a schema constraint to application-layer
-- validation timing — the row is only ever inserted after AWS KMS already succeeded (AC-1).
ALTER TABLE "vault_state" ADD COLUMN IF NOT EXISTS "kms_key_id" text;
ALTER TABLE "vault_state" ADD COLUMN IF NOT EXISTS "kms_encrypted_dek" text;
