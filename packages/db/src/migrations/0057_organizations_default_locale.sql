-- Story 15.2: org-level default display-language for newly invited/self-signed-up users. Purely
-- additive — NOT NULL with a DEFAULT backfills every existing row to 'en', preserving pre-Story-
-- 15.2 registration behavior exactly for any org that never explicitly configures this setting
-- (AC 2 edge case). The CHECK constraint mirrors organizations.ts's existing enum/range-
-- constrained-column precedent (organizations_dormancy_threshold_check /
-- organizations_user_dormancy_threshold_check) and MUST stay in sync with
-- packages/shared/src/constants/locales.ts's SUPPORTED_LOCALES list, the API's zod enum, and the
-- users_locale_check constraint added by migration 0056 (Story 15.1) — this column only ever
-- *seeds* users.locale's initial value at registration time, it never overrides it afterward.
ALTER TABLE "organizations" ADD COLUMN "default_locale" text NOT NULL DEFAULT 'en';

ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_default_locale_check"
  CHECK ("organizations"."default_locale" IN ('en', 'es'));
