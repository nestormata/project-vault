-- Story 15.1: personal display-language preference. Purely additive — NOT NULL with a DEFAULT
-- backfills every existing row to 'en', preserving pre-Phase-2 behavior exactly (AC 7 edge case).
-- The CHECK constraint mirrors organizations.ts's enum-constrained-column precedent
-- (organizations_dormancy_threshold_check) and MUST stay in sync with
-- packages/db/src/supported-locales.ts's SUPPORTED_LOCALES list and the API's zod enum.
ALTER TABLE "users" ADD COLUMN "locale" text NOT NULL DEFAULT 'en';

ALTER TABLE "users"
  ADD CONSTRAINT "users_locale_check"
  CHECK ("users"."locale" IN ('en', 'es'));
