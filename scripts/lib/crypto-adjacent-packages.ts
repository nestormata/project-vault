/**
 * Story 42.3 — the single canonical "is this package crypto-adjacent" list.
 *
 * This is the one source of truth for which npm packages carry password-hashing, session-token
 * signing, or other cryptographic-primitive behavior that this repo exact-pins (no `^`/`~`/range)
 * and keeps out of Dependabot's catch-all auto-grouped PR — a semver-legal minor bump to any of
 * these can silently change a KDF parameter, a constant-time comparison, or a signing algorithm
 * default with no behavioral test catching it (see this story's ACs for the full rationale).
 *
 * Two consumers must both read from this list, not re-declare their own copy:
 *   1. `scripts/check-crypto-adjacent-pins.ts` (AC4) — the exact-pin CI gate, which imports this
 *      array directly (a real TS import).
 *   2. `.github/dependabot.yml`'s `groups.crypto-adjacent.patterns` and
 *      `groups.pnpm-workspace.exclude-patterns` (AC3) — YAML cannot `import` a `.ts` const, so
 *      `scripts/check-crypto-adjacent-pins.test.ts` instead hand-parses `dependabot.yml` and
 *      cross-checks its two package lists against this array (see this story's Dev Notes ADR on
 *      why that cross-check is hand-parsed rather than pulling in a YAML-parsing dependency).
 *
 * If this list ever changes (a package added or removed), BOTH consumers above must be updated in
 * the same change — the cross-check test is the circuit-breaker that fails CI if `dependabot.yml`
 * drifts out of sync with this array, but nothing stops a `dependabot.yml`-only edit from shipping
 * without a corresponding update here except code review, so treat this file and `dependabot.yml`'s
 * two group lists as one unit whenever either is touched.
 *
 * Populated 2026-09-20 (Story 42.3, re-verified against `main` per Task 1): the three packages
 * originally named by the epic (`argon2`, `bcrypt`, `@fastify/jwt`), plus two more found via
 * Task 1's expanded fourth-package search — neither was caught by the story's originally-drafted
 * grep patterns, both are genuinely crypto-adjacent, and both are recorded in this story's Dev
 * Agent Record:
 *   - `fast-jwt`: declared directly in `apps/api/package.json` and
 *     `fixtures/mock-envelope-extension/package.json`, used for real JWT signing/verification in
 *     `apps/api/src/plugins/machine-jwt.ts` and `apps/api/src/modules/auth/handoff-verify.ts` — a
 *     JWT library beyond `@fastify/jwt`, exactly the category AC1's edge example calls out to check
 *     for. Missed by the original grep list because it searches for literal substrings
 *     (`jose`/`jsonwebtoken`) that don't match the package name `fast-jwt`.
 *   - `otpauth`: declared directly in `apps/api/package.json`, `apps/web/package.json`, and
 *     `packages/api-contract-tests/package.json`, used for real TOTP generation/verification (HMAC-
 *     based one-time passwords) in `apps/api/src/modules/auth/totp.ts` and its MFA/recovery call
 *     sites — a TOTP library, exactly the category AC1's edge example calls out to check for.
 *     Missed by the original grep list because it searches for the literal substring `totp`, which
 *     does not appear in the package name `otpauth`.
 * See this story's Dev Agent Record for the full Task 1 re-verification trail.
 */
export const CRYPTO_ADJACENT_PACKAGES: readonly string[] = [
  'argon2',
  'bcrypt',
  '@fastify/jwt',
  'fast-jwt',
  'otpauth',
]
