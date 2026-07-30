# Story 18.9: Fix SSO Domain Validation False Rejection

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an org admin configuring SSO domains,
I want to add a legitimate multi-label domain like `profesional.co.cr`,
so that I'm not blocked from configuring SSO for a domain I actually own just because the validator incorrectly treats it as invalid.

## Product Surface Contract

| Field | Value |
|-------|-------|
| **Surface scope** | `both` |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | See below |

### Persona journey stub

Riley-admin adds `profesional.co.cr` as an SSO domain. Validation accepts it (it's a syntactically valid domain), and if any public-domain-registry check applies, it doesn't false-positive on legitimate multi-label ccTLD domains.

## Acceptance Criteria

1. **Root-cause the actual rejection before fixing anything** — initial investigation of `packages/shared/src/schemas/auth.ts`'s `DOMAIN_LABEL_PATTERN` regex (line 122) found it already permits arbitrary dot-separated labels (`(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*`), so `profesional.co.cr` should pass this specific regex as written. Reproduce the actual rejection Nestor hit (exact input, exact error/error code returned) before assuming the regex is the bug.
2. **Blocklist hypothesis checked and ruled out — do not assume it's the cause**: `PUBLIC_EMAIL_DOMAINS` (`apps/api/src/modules/auth/org-sso-domains-service.ts:17-27`) is confirmed to be a flat ~11-entry set of consumer email providers (gmail.com, yahoo.com, etc.), not a PSL/eTLD-based heuristic — `profesional.co.cr` is nowhere near this list and cannot be rejected by it. Since both the regex (confirmed permissive) and this blocklist (confirmed unrelated to ccTLD structure) pass this input, the root cause is somewhere else entirely and must be found by actual reproduction, not presupposed. Check `normalizeSsoDomain` (`packages/shared/src/schemas/auth.ts:114`), any additional validation in `apps/api` (`org-sso-domains-service.ts` or its route handler), and any UI-side length/format constraint in the web form — trace the exact code path a real submission of `profesional.co.cr` takes and find where the rejection actually happens before writing a fix.
3. Once root-caused, fix the actual confirmed defect so `profesional.co.cr` and other legitimate multi-label domains are accepted, without loosening validation in a way that would newly accept genuinely invalid input. Do not apply AC-4/PSL-related changes speculatively if the investigation finds the cause is unrelated to public-suffix logic (e.g. a UI-side bug, a length limit, a normalization mismatch) — fix what's actually broken. **This AC is blocked until AC-1's reproduction is conclusive** (an exact input, exact code path, and exact rejection point identified) — if the investigation is inconclusive, do not proceed to a best-guess fix; escalate instead of shipping a fix for an unconfirmed cause.
4. **Only if** the confirmed root cause is genuinely a public-suffix/eTLD-style check (not yet found in this codebase as of this story's authoring — confirm before assuming it exists at all): prefer switching to (or supplementing with) a maintained public-suffix list source, or document why a hardcoded list is intentionally kept minimal. This AC does not apply if no such mechanism is found to be the cause.
5. A regression test is added asserting `profesional.co.cr` and other multi-label ccTLD domains (e.g. `example.co.uk`, `example.com.br`) pass validation, alongside additional edge cases: a single-label/no-TLD input, a domain with a trailing dot, mixed-case input (normalization), and at least one domain that legitimately *should* still be rejected under the fix (proving the fix doesn't over-loosen validation).
6. If `normalizeSsoDomain`'s output shape changes as part of this fix, this is checked against actual stored domain values (in a real/demo database snapshot, not just reasoned about abstractly) before merge — query existing `org_sso_domains` rows through the new normalization function and confirm none would shift shape unexpectedly, breaking SSO login for orgs configured before the fix. State explicitly whether a data migration/backfill is needed based on that real check, or document why none is, with the query/verification evidence noted in Dev Agent Record.
7. No unrelated SSO domain behavior (verification flow, uniqueness checks, org-scoping) changes.

## Tasks / Subtasks

- [ ] Task 1: Reproduce the exact rejection end-to-end (web form → API → schema) and identify the real cause (AC: 1, 2)
- [ ] Task 2: Fix the confirmed root cause only (AC: 3, 4)
- [ ] Task 3: Assess normalization/migration impact (AC: 6)
- [ ] Task 4: Regression tests incl. edge cases (AC: 5, 7)

## Dev Notes

- **Do not fix the regex reflexively** — initial analysis strongly suggests `DOMAIN_LABEL_PATTERN` (`packages/shared/src/schemas/auth.ts:122`) already supports multi-label domains as written; changing it without confirming it's actually the failing check risks masking the real bug and shipping a no-op fix.
- **The blocklist hypothesis from this story's first draft was checked against the actual code and is wrong** — `PUBLIC_EMAIL_DOMAINS` (`apps/api/src/modules/auth/org-sso-domains-service.ts:17-27`) is a short, flat list of consumer email providers, not a ccTLD/PSL mechanism. There is currently no PSL/eTLD-style logic anywhere in this codebase to "fix" — do not go looking for one. The real cause is unexamined as of this story's authoring; approach this as a genuine investigation, not a confirmation of a pre-formed theory.
- `OrgSsoDomainFieldSchema` (`packages/shared/src/schemas/auth.ts:148-153`) wires the regex via `.refine(isValidDomainLabel, ...)` — trace every `.refine`/check in this schema chain, plus `apps/api/src/modules/auth/org-sso-domains-service.ts` and the web form's own client-side validation, to find where `profesional.co.cr` actually gets rejected.

### Project Structure Notes

- Fix is likely confined to `packages/shared/src/schemas/auth.ts` and its test file; verify whether `apps/api` has any additional/duplicate validation for SSO domains before assuming the shared schema is the only place to fix.

### References

- [Source: packages/shared/src/schemas/auth.ts]
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
