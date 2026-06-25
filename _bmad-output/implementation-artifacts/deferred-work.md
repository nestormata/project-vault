# Deferred Work

## Deferred from: code review of story-1.3 (2026-06-24)

- `apps/api/src/lib/cors.test.ts` only covers one disallowed-origin case; no test for a missing `Origin` header or substring/case-sensitivity allow-list bypass variants (e.g. `http://localhost:5173.evil.com`).
- CORS rejection in `apps/api/src/app.ts` returns HTTP 500 instead of a proper 4xx; behavior is correctly tested as-is per AC #14, but the underlying error-handling design is arguably a defect for a future story to fix.
- No `.dockerignore` exists despite multi-arch and image-size-sensitive Docker builds.
- AC #14's illustrative code block in the story file still shows `403`, but the shipped test asserts `500` per the AC's own "assert actual behavior" instruction — minor spec-hygiene drift.

## Deferred from: code review of story-1.4 (2026-06-24)

- `check-rls-coverage.ts` infers "org-scoped" purely from a column literally named `org_id` — brittle naming-convention heuristic with no positive table registry. Deferred: this is how AC-10 is explicitly specified; changing it is a spec-level decision beyond this story.
- `withOrgReadScope()` is functionally identical to `withOrg()` — no real read/write distinction despite the name. Deferred: explicitly acknowledged in Story 1.4's own Dev Notes as "differentiated in a later story."
- `GRANT CREATE ON DATABASE project_vault TO vault_app` is a broad, database-wide grant added for pg-boss's schema bootstrap rather than scoped to a dedicated schema. Deferred: already documented and user-approved as a scope deviation in the Story 1.4 Dev Agent Record.
- `docker-compose.yml`'s `migrate` service rebuilds the full `api` builder stage on every cold start just to run one migration command. Deferred: pre-existing tradeoff from the documented scope deviation; an optimization, not a defect.
- `getDb()` singleton in `packages/db/src/index.ts` has no recovery path if the underlying connection pool dies. Deferred: pre-existing connection-management architecture beyond Story 1.4's scope; broader resilience work is a future concern.
