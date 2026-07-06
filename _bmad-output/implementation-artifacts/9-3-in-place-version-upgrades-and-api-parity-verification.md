# Story 9.3: In-Place Version Upgrades & API Parity Verification

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->
<!-- Ultimate context engine analysis completed 2026-07-06 — comprehensive developer guide for the THIRD story of Epic 9 (Platform Operations, API & Self-Hosting). This story does NOT have a hard sequencing prerequisite on Stories 9.1/9.2 (unlike 9.2 on 9.1) — it touches a disjoint set of files (migration tooling, OpenAPI generation, a new contract-test package, pagination schemas) and can be implemented independently of whether 9.1/9.2 have merged. This story's defining characteristic is that it is a VERIFICATION-and-HARDENING story, not a first-time-feature story: every one of its nine Key Design Decisions below is grounded in a concrete, already-verified gap in the current codebase (not a hypothetical) — read D1-D9 before writing any code, they tell you exactly which files are stubs, which fields are silently dropped from real HTTP responses today, and which existing mechanisms to reuse rather than reinvent. Getting D4/D7 wrong (the OpenAPI generation rewrite and the schema-vs-actual-response drift rule) means the contract test suite this story delivers would pass while the exact class of bug it exists to catch (D7's machine-users example) ships silently. -->

## Story

As a **platform operator upgrading a running self-hosted Project Vault deployment**,
I want **in-place version upgrades that preserve all data and refuse unsafe schema changes, plus a contract-tested, fully complete OpenAPI specification covering every registered endpoint**,
so that **I can upgrade without downtime risk to my data, and API consumers (my own scripts, CI/CD integrations, or third-party tooling) have a reliable, machine-verified contract instead of a hand-maintained, silently-incomplete document**.

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `api` |
| **Evaluator-visible** | yes — indirectly. There is no new SvelteKit screen in this story (backend/tooling only), but `GET /api/v1/docs` (Swagger UI, D5) is the first time this codebase ships a browsable, evaluator-facing view of the *entire* API surface. This is the "product" a REST API consumer sees, in the same sense the web UI is the product a human user sees. |
| **Linked UI story** (if API-only) | `TBD` — no story in `epics.md` (Epic 9's five stories, or any other epic) scopes an admin-web-UI screen for triggering an in-place upgrade or browsing API docs from within the app shell (the Swagger UI at `/api/v1/docs` is a developer-facing surface, not an operator-facing SvelteKit page). Same accepted-gap pattern already flagged by Stories 9.1 and 9.2's Product Surface Contracts; raise again at Epic 9 sprint planning/retrospective (G2). |
| **Honest placeholder AC** (if UI deferred) | N/A — no SvelteKit route is stubbed in this story, matching Stories 9.1/9.2's precedent exactly (a dead route with no linked follow-up story is worse than no route). |
| **Persona journey** | N/A (API-only) — the "persona" is (a) a platform operator running `docker compose pull && docker compose up -d` per the runbook (Story 9.5) and observing migration success/failure at the container log level, and (b) an API-consuming developer visiting `GET /api/v1/docs` in a browser to read the live, complete OpenAPI spec. Both journeys are exercised by this story's ACs (AC-1/AC-2 for the operator, AC-6/AC-7 for the developer) rather than a persona-journey narrative, consistent with Stories 9.1/9.2's API-only precedent. |

---

## Key Design Decisions & Open Questions

**Read this section before writing any code.** Unlike a greenfield feature story, every decision below is anchored to a fact already verified by reading the current codebase (file paths and line-level behavior cited throughout) — not epics.md's aspirational description of what the architecture *should* look like. In several places, epics.md's and architecture.md's literal text describes a mechanism (auto-generated OpenAPI spec, mocked-I/O `generate-spec.ts`, migration-on-container-startup) that **does not exist yet** in the shipped code; this story is what makes that description true.

### D1 — Migration-on-upgrade already exists as a one-shot Compose service; do not duplicate it in `apps/api`

Epics.md's literal Story 9.3 AC text says *"the API container runs pending Drizzle migrations automatically on startup before serving any requests."* Read literally this implies migration logic living inside `apps/api/src/main.ts`. That is **not** how this repository is built, and duplicating it there would be a regression, not an enhancement.

**Verified fact:** `docker-compose.yml` already defines a **`migrate` service** — a one-shot container (same image, `target: builder`, command `pnpm --filter @project-vault/db db:migrate`) that runs `drizzle-kit migrate` against the database before the `api` service is allowed to start. The `api` service's `depends_on` block requires `migrate: condition: service_completed_successfully` — Docker Compose will not start `api` at all if `migrate` exits non-zero. This already satisfies the *intent* of epics.md's AC text ("migrations run automatically on `docker compose up -d`; a failed migration prevents the API from serving traffic") — it is simply implemented as a sibling one-shot container rather than inline in `apps/api`'s own startup sequence, and this is the **better** pattern (the API image never needs the `postgres` superuser role or drizzle-kit's CLI dependencies bundled into its runtime layer — see `apps/api/Dockerfile`'s multi-stage `runner` target, which strips build tooling).

**Resolution:** Keep the existing `migrate`-service architecture. Do **not** add a migration-runner call to `apps/api/src/main.ts` or `app.ts`. This story's job is to make the `migrate` service **safe** (D2) and **verifiable** (D3's CI script), not to relocate it.

### D2 — `db:migrate` today is raw `drizzle-kit migrate` with zero destructive-operation guard; add a wrapper, not a fork of drizzle-kit

**Verified fact:** `packages/db/package.json`'s `db:migrate` script is literally `"drizzle-kit migrate"` — the unmodified CLI. It has no hook point for "check what's about to run, refuse if destructive." Epics.md's blocker AC-E9b requires exactly this: *"the migration runner checks for destructive operations (DROP COLUMN, RENAME COLUMN) and refuses to apply them in auto-migrate mode, requiring explicit `--allow-destructive` flag."*

**Resolution:**
1. New shared helper module `packages/db/src/lib/migration-safety.ts` exporting `findDestructiveStatements(sql: string): string[]`. Before pattern-matching, **strip SQL line comments (`-- ...`), block comments (`/* ... */`), and string literals (both `'...'` and dollar-quoted `$$...$$` blocks) from the input** so that a destructive keyword appearing only inside a comment or a string literal (e.g. a migration's own descriptive comment mentioning `DROP COLUMN`, or a data-migration `UPDATE` statement whose literal text happens to contain the substring) does not produce a false positive, and so a destructive statement disguised inside a comment-stripped context is still detected. After stripping, run a case-insensitive keyword/regex scan for the following patterns — **verified against this repo's current 35 migrations (all patterns): zero matches for every pattern below, so this expanded scope is a strict superset that still passes retroactively with zero changes (see D3/AC-18)**:
   - `DROP COLUMN`, `DROP TABLE` (existing scope)
   - `RENAME COLUMN`, `RENAME TO` / `ALTER TABLE ... RENAME` (existing scope)
   - `TRUNCATE` (any form, including `TRUNCATE TABLE`)
   - `DELETE FROM` (a bare data-deleting statement, not a schema change, but destructive in the same sense — irreversible data loss)
   - `DROP CONSTRAINT`
   - `DROP DEFAULT`
   - `ALTER COLUMN ... TYPE` (**flag conservatively — any column type change**, not just narrowing ones; distinguishing a safe widening change (e.g. `varchar(50)` → `varchar(200)`) from an unsafe narrowing one (`varchar(50)` → `varchar(10)`) would require introspecting the live schema's current column width, which this static, DB-free scan cannot do — treat every `ALTER COLUMN ... TYPE` as destructive-by-default and let `--allow-destructive` be the operator's confirmation that a specific widening change is actually safe; this trades a few false positives on safe widening changes for zero false negatives on unsafe narrowing ones)
   - `ADD COLUMN ... NOT NULL` where the same statement has no `DEFAULT` clause (this fails or requires a backfill against existing rows on a non-empty table)
2. New wrapper script `packages/db/src/scripts/guarded-migrate.ts`: reads all `.sql` files in `packages/db/src/migrations/` that drizzle-kit's own journal (`packages/db/src/migrations/meta/_journal.json`) reports as **not yet applied** (drizzle-kit's migrator already tracks applied-migration state in a `__drizzle_migrations` table — this script reads the same journal file drizzle-kit consults, it does not need its own bookkeeping table). For each pending file, run `findDestructiveStatements()`; if any pending file has destructive statements and `process.argv` does not include `--allow-destructive`, log a clear pino-style structured error identifying the offending file(s) and statement(s), then `process.exit(1)` **without** invoking drizzle-kit at all (fail before touching the DB). Otherwise, invoke the existing `drizzle-kit migrate` behavior (shell out via `child_process.execFileSync('drizzle-kit', ['migrate'], { stdio: 'inherit' })` — do not reimplement drizzle-kit's own migration-application logic).
3. `packages/db/package.json`'s `db:migrate` script becomes `"tsx src/scripts/guarded-migrate.ts"`. **`docker-compose.yml` needs zero changes** — it invokes the script by its package.json name (`pnpm --filter @project-vault/db db:migrate`), not by the underlying command, so swapping the implementation behind that name is fully transparent to the Compose file and to CI's own `pnpm db:migrate` invocation.
4. `--allow-destructive` is a manual, explicit, human-typed flag — it is never set by any automated path (Compose, CI, `main.ts`), **and the normal upgrade path (`docker compose up -d`) can never pass it**, because that path recreates the `migrate` service using its fixed, non-interactive default command with no way to inject an extra CLI argument. **This is intentional, not an oversight**: the concrete bypass mechanism for a containerized deployment is a separate, manual, one-off invocation the operator runs themselves — `docker compose run --rm migrate pnpm --filter @project-vault/db db:migrate --allow-destructive` — which requires **zero `docker-compose.yml` changes**, because `docker compose run <service> <command>` already overrides a service's configured command with an inline one; it does not need the compose file to declare a flag-passthrough mechanism. The operator's workflow for a release containing a destructive migration is therefore: (a) `docker compose up -d` fails at the `migrate` step exactly as AC-3 describes (the normal path always refuses); (b) the operator manually runs the `docker compose run --rm migrate ... --allow-destructive` command above, once, after completing the documented offline procedure; (c) the operator re-runs `docker compose up -d`, which now finds no pending destructive migrations left unapplied and proceeds normally. Document in Story 9.5's runbook cross-reference (Open Question 1 below) that using it requires the "documented offline migration procedure" per AC-E9b — this story does not need to write that procedure itself (9.5's job), only to gate the flag correctly, document the exact `docker compose run` invocation above, and point to where the offline procedure will live.

### D3 — `scripts/migration-compatibility-check.ts` (root, CI-only) reuses D2's helper; verified to pass retroactively against all 35 existing migrations

Epics.md separately requires *"a `migration-compatibility-check.ts` CI script verifies all migrations in the `migrations/` directory are additive-only."* This is a distinct concern from D2's runtime guard: D2 only inspects **pending** migrations at deploy time; this is a **static, full-history** CI gate that runs on every PR regardless of DB state, matching the existing convention of root-level `scripts/check-*.ts` files (`scripts/check-rls-coverage.ts`, `scripts/check-search-index.ts`, etc., each wired to a `pnpm check-*` root script and a CI step).

**Resolution:**
1. New `scripts/migration-compatibility-check.ts` (root `scripts/`, matching sibling scripts' location and style) imports `findDestructiveStatements` from `@project-vault/db`'s exported `lib/migration-safety.js` (export it from `packages/db/src/index.ts` or a dedicated sub-export — do not duplicate the regex logic here; a second copy would trip the repo's `jscpd` zero-duplication CI gate, `pnpm jscpd`, the same reason `packages/shared/openapi.json` schema helpers get centralized).
2. Scans **every** `.sql` file under `packages/db/src/migrations/` (not just pending ones — this is a full-repo-history check, since a destructive migration merged in the past is exactly as dangerous on a fresh install running a later downgrade/rollback scenario as one merged today). Exits non-zero, listing every offending file, if any are found.
3. **Verified fact:** a direct scan of all 35 existing migrations (`0000_initial_schema.sql` through `0035_rotations_status_initiated_org_id.sql`) confirms **zero** contain any pattern in D2's full expanded scope — `DROP COLUMN`, `DROP TABLE`, `RENAME COLUMN`, `RENAME TO`, `TRUNCATE`, `DELETE FROM`, `DROP CONSTRAINT`, `DROP DEFAULT`, `ALTER COLUMN ... TYPE`, or `ADD COLUMN ... NOT NULL` without a `DEFAULT`. (Two migrations — `0012_refresh_tokens_org_id.sql` and `0033_break_glass_and_stale_recovery.sql` — do use bare `ADD COLUMN` without a `DEFAULT`, but neither adds a `NOT NULL` constraint, so neither matches the flagged pattern.) This check will pass immediately on the current `main` with no migration-file changes required, even against the expanded scope. Do not "fix" any existing migration; there is nothing to fix.
4. Add root `package.json` script: `"check-migration-compatibility": "tsx scripts/migration-compatibility-check.ts"`. Add a new CI step in `.github/workflows/ci.yml`'s `quality-gates` job (near the existing `Check RLS policy coverage` / `Check search index safety` steps, same style) named `Check migration compatibility (AC-E9b)` running `pnpm check-migration-compatibility` — this step needs **no** `DATABASE_URL` env (it is a pure static file scan, no DB connection).

### D4 — `generate-spec.ts` is a hand-maintained stub covering 8 of 100+ real routes; replace with real Fastify/`@fastify/swagger` introspection, without requiring a live database

**Verified fact (the core defect this story exists to fix):** `apps/api/src/scripts/generate-spec.ts` is **not** driven by `@fastify/swagger` at all — it is a hardcoded `JSON.stringify()` literal documenting exactly 8 paths (`/api/v1/auth/register`, `/login`, `/refresh`, `/me`, `/sessions` ×2, `/logout`, and `/org/users/:userId/sessions`). Meanwhile `apps/api/src/app.ts` **already** registers `@fastify/swagger` correctly (`fastify.register(swagger, { openapi: {...}, transform: jsonSchemaTransform })`, line 142) against **every** real route across 20+ modules (`credentials`, `rotation`, `monitoring`, `machine-users`, `audit`, `admin`, `projects`, `search`, `notifications`, `dashboard`, `vault`, etc. — see `apps/api/src/app.ts`'s full route-registration block). The live, richly-detailed spec `@fastify/swagger` would generate from those real route/Zod schemas is simply never written to `packages/shared/openapi.json` — the committed file is 8 paths; the real registered surface is 100+. CI's "Generate spec and check freshness" step (`.github/workflows/ci.yml`) currently only proves the 8-path stub is self-consistent (`git diff --exit-code` against a file the script itself regenerates identically every time) — it provides **zero** actual parity verification, which is exactly the gap FR47/AC-E9a exist to close.

**Resolution:**
1. Rewrite `generate-spec.ts` to: set `process.env.DATABASE_URL` and `process.env.CORS_ALLOWED_ORIGINS` to safe, syntactically-valid placeholder values (e.g. `postgresql://vault_app:unused@localhost:5432/unused` and `http://localhost:5173`) **only if not already set** — `apps/api/src/config/env.ts`'s Zod schema requires both unconditionally (`DATABASE_URL: z.string().min(1).refine(...)`, `CORS_ALLOWED_ORIGINS: z.string().min(1)...`, both with no `.default()`), so importing `app.js` without them throws at module-parse time. **This never opens a real database connection**: `packages/db/src/index.ts`'s `getDb()` lazily constructs the `postgres()` client only on first call, and the underlying `postgres` npm driver itself connects lazily on first query — registering Fastify routes and their Zod/JSON schemas never issues a query, so no live Postgres is ever touched.
2. Call `const app = await createApp({ logger: false })` (the exact factory every existing integration test already uses — `apps/api/src/__tests__/auth.integration.test.ts` line 6 et al.), then `await app.ready()` (required before `.swagger()` is guaranteed populated — a common `@fastify/swagger` gotcha), then `const spec = app.swagger()`, then `await app.close()`.
3. Write `JSON.stringify(spec, null, 2) + '\n'` to `packages/shared/openapi.json` (same output path as today).
4. **This requires no changes to CI env wiring.** Neither the existing "Typecheck" step (which transitively runs `generate-spec` via `turbo.json`'s `"typecheck": { "dependsOn": ["generate-spec"] }`) nor the explicit "Generate spec and check freshness" step currently sets `DATABASE_URL` — and per point 1 above, the rewritten script still doesn't need it to. Do not add `DATABASE_URL`/`VAULT_APP_DATABASE_URL` to either CI step; doing so would be unnecessary scope creep and could mask the property this design deliberately preserves (spec generation must work identically for a contributor with no Docker/Postgres running locally).
5. Add a regression test (`apps/api/src/scripts/generate-spec.test.ts` or a sibling `__tests__` file) asserting the generated spec's `Object.keys(spec.paths).length` is at least, say, 60 (a generous floor well above the old stub's 8, that will naturally grow as routes are added, without hardcoding an exact brittle count) — this is the automated regression guard against ever silently reverting to a hand-maintained stub.

### D5 — Swagger UI + live `/api/v1/openapi.json` route; gated outside production by default (security-conscious divergence from epics.md's literal always-on text)

Epics.md says plainly: *"`GET /api/v1/openapi.json` returns the complete v1 spec; `GET /api/v1/docs` serves the Swagger UI."* Neither route exists today (verified: no route registration anywhere matches `/openapi.json` or `/docs`; `@fastify/swagger-ui` is not in `apps/api/package.json`'s dependencies, only `@fastify/swagger` is).

**Resolution:**
1. Add `@fastify/swagger-ui` to `apps/api/package.json` dependencies (compatible with the already-pinned `fastify@5.8.5`/`@fastify/swagger@^9.7.0`).
2. Register it in `apps/api/src/app.ts` immediately after the existing `swagger` plugin registration, with `routePrefix: '/api/v1/docs'`.
3. Add an explicit route `GET /api/v1/openapi.json` returning `fastify.swagger()` directly (`@fastify/swagger-ui` does not automatically expose the raw JSON at a caller-chosen path; register this as a thin handler in `apps/api/src/routes/health.ts`'s sibling pattern, or a new tiny `apps/api/src/routes/openapi.ts`).
4. **Security-conscious divergence, matching this epic's established precedent (Story 9.2's D2 — MFA-hardening beyond epics.md's literal text) of tightening security posture beyond epics.md's literal wording when the project's own architecture already sets a stricter bar:** gate both routes behind `const docsEnabled = env.ENABLE_API_DOCS === true || env.NODE_ENV === 'development' || env.NODE_ENV === 'test'` (new optional `ENABLE_API_DOCS` env var, default `false`). **This is a deliberate fail-closed design, not the more obvious `env.NODE_ENV !== 'production'` inversion** — a naive `!== 'production'` check defaults to *exposing* docs for any unrecognized `NODE_ENV` value (a typo, an unset variable in some deployment tooling, a custom value like `"staging"`, or a differently-cased `"Production"`), which is exactly backwards for a security-sensitive gate. The allowlist form above only enables docs for the two specific values this codebase's own tooling actually sets (`development` locally, `test` in CI/vitest), and defaults closed for every other value, including anything unrecognized. A self-hosted secrets-management product should not, by default, expose a fully browsable map of every authenticated route + its exact request/response schema to anyone who can reach the API port — this is meaningful reconnaissance value for an attacker that the existing `helmet`/CSP hardening (`app.ts` lines 153-168) is otherwise designed to minimize. Document `ENABLE_API_DOCS` in `.env.example` with a one-line comment explaining the trade-off, and cross-reference this decision in Story 9.5's runbook (Open Question 2 below) so operators who *want* docs exposed in production (e.g., behind their own reverse-proxy auth) know the flag exists. (**Verified fact:** `apps/api/src/config/env.ts:313` already declares `NODE_ENV: z.enum(['development', 'test', 'production']).default('development')` — a genuinely malformed/misspelled value fails Zod validation at startup rather than silently falling through, so the practical blast radius of the naive `!== 'production'` form is narrower than an unconstrained string comparison would be; the allowlist form is still adopted here as the more defensible, self-documenting default-closed pattern for a security gate, and costs nothing over the negation form given the enum's fixed value set.)
5. When gated off, both routes return `404` (Fastify's default for an unregistered route — i.e., conditionally **skip registering** the plugin/route entirely rather than registering-then-403ing, so their absence from the OpenAPI spec itself is truthful).

### D6 — Contract test suite: new `packages/api-contract-tests`, driven by `app.inject()` against a migrated test database — not a separately bound HTTP server

Epics.md requires *"a contract test suite (`packages/api-contract-tests/`) enumerates all routes from the generated OpenAPI spec, sends a request to each, and verifies the response matches the documented schema; this suite runs as a required CI check"* and separately, in the integration-test list, *"contract test suite passes against a running instance."*

**Resolution:**
1. New workspace package `packages/api-contract-tests` (`@project-vault/api-contract-tests` — auto-picked-up by the existing `pnpm-workspace.yaml`'s `packages/*` glob, no workspace config changes needed). Depends on `@project-vault/api` (workspace dependency, for `createApp`), `@project-vault/shared` (for `openapi.json`), `ajv` (already a transitive dependency of `@fastify/type-provider-zod`'s toolchain — do not add a second JSON-schema-validation library; pin it as a direct `devDependency` here since it's used directly in this package's own code, not just transitively).
2. **"Against a running instance" is satisfied by `createApp({ logger: false })` + Fastify's `app.inject()`** (the exact mechanism every existing `apps/api/src/__tests__/*.integration.test.ts` file already uses) rather than binding a real TCP listener and making real HTTP calls — `app.inject()` exercises the complete real pipeline (routing, auth middleware, Zod validation, the actual service/repository/DB-transaction layer against a real migrated test Postgres via the same `DATABASE_URL`/`.env.test` convention as `apps/api`'s own tests, and response serialization) with no meaningful gap versus a bound socket. Document this interpretation explicitly in this package's README/top-of-file comment so a future reader does not mistake the absence of `docker compose up` from this suite's CI step as the suite not testing "a running instance."
3. Test flow: (a) run migrations against the CI Postgres service (already done earlier in the same CI job — reuse it, do not spin a second database), (b) `createApp({ logger: false })`, (c) bootstrap fixture data via a small helper reusing `packages/db/src/test-helpers.ts`'s `withTestOrg()` pattern plus a real `POST /api/v1/auth/register` + `POST /api/v1/auth/login` `app.inject()` call to obtain a real session cookie (do not synthesize a JWT by hand — exercising the real auth path is itself part of what "against a running instance" should mean), (d) also bootstrap a second, fully separate org ("org B") with its own real register/login flow, and register a **platform-operator** session **only if that role/mechanism exists in the codebase at implementation time** — see the explicit sequencing note below — plus an **org-admin (non-platform-operator)** session, since several routes' documented `401`/`403` responses (AC-15) require the org-admin identity to exercise correctly, (e) load `packages/shared/openapi.json` (the freshly-generated file from D4 — this suite must run **after** `pnpm generate-spec` in CI ordering, so it is testing the current tree's real spec, not a stale one), (f) for every `path`+`method` combination, issue the appropriate `app.inject()` call (path params filled with fixture IDs where the OpenAPI schema declares them; body/query filled with minimal valid fixtures per the documented request schema) and assert the response status is one the spec documents for that operation, and that the JSON body validates against that status's documented response schema via `ajv`, (g) for at least one representative resource-fetch route per module that returns org-scoped data by ID (e.g. `GET /api/v1/projects/:projectId`, `GET /api/v1/projects/:projectId/credentials/:credentialId`), additionally invoke it using org B's session against a resource ID that belongs to org A, and assert the response is the route's documented not-found/forbidden status (`404` or `403`, whichever that route documents for an inaccessible resource) — **never** the org-A resource's real data. This is a first-class tenant-isolation regression check (AC-22 below), not an incidental side effect of the fixture setup.

**Sequencing note (resolves an apparent contradiction with D9):** D9 states this story has no *hard* dependency on Stories 9.1/9.2 in the sense of shared files or a merge-order requirement — that remains true; 9.3's own files (migration tooling, OpenAPI generation, the new contract-test package, pagination schemas) are entirely disjoint from 9.1/9.2's files. However, AC-15's full negative-path coverage for *platform-operator-gated* routes specifically depends on the platform-operator role/session mechanism that Stories 9.1/9.2 introduce (both still `ready-for-dev`, not yet implemented, as of this story's creation). The contract suite must therefore **feature-detect** rather than hard-require this: at suite startup, attempt to bootstrap a platform-operator session only if the underlying registration/role-assignment mechanism (`packages/db/src/test-helpers.ts` or equivalent) exists; if it does not yet exist, skip platform-operator-specific negative-path assertions for this run (there are currently zero platform-operator-only routes in the generated spec to test against, so this is a true no-op, not a coverage gap) and log a single informational note in the suite's summary output noting the skip, so a reviewer isn't left wondering why platform-operator coverage is absent. Once 9.1/9.2 land (in either order relative to 9.3), the feature-detection naturally starts exercising those routes' negative paths with zero changes to this suite's own code — this is the concrete mechanism that makes "any implementation order" true in practice, not just in principle.
4. Add `turbo.json` task: `"@project-vault/api-contract-tests#test": { "dependsOn": ["^build", "@project-vault/api#build", "@project-vault/db#test"], "cache": false }` (mirrors the existing `@project-vault/api#test` task's dependency shape). Because it is a workspace package under `packages/*`, `pnpm turbo test` already picks it up automatically — **no separate CI step is strictly required**, but add one anyway for visibility/required-check clarity per AC-E9a's explicit "manual parity checklist is not acceptable for sign-off, must be a required CI check" language: a named step `API contract parity tests` running `pnpm --filter @project-vault/api-contract-tests test`, placed after the "Generate spec and check freshness" step (needs the fresh spec) and using the same `VAULT_APP_DATABASE_URL` env the existing "Test" step uses.

### D7 — The FR97 pagination-field rule must be enforced independently of each route's own declared response schema (this is the exact class of bug D8 found)

A naive contract-test design ("does the response match its own declared schema?") would **not** have caught the concrete bug documented in D8 point 1 below, because a response can conform perfectly to a schema that is itself incomplete. `@fastify/type-provider-zod`'s response serializer uses each route's own Zod object schema to serialize the response — Zod's default object mode **strips any key not declared in the schema**. If a handler computes and returns `{ items, total, page, limit, hasNext }` but the route's declared response schema only lists `items`/`total`, the actual bytes sent over the wire silently omit `page`/`limit`/`hasNext` — and "response matches its declared schema" is trivially true, because the schema and the (already-stripped) response agree with each other. Only a rule that is *independent of what any given route's author chose to declare* can catch this.

**Resolution:** the contract-test suite (D6) implements a second, independent check alongside per-route schema conformance: **for every 2xx JSON response whose parsed body's `data` property is an object containing at least one array-typed field (regardless of that field's name — `items`, `results`, etc.), assert the actual parsed body also contains `total: number`, `page: number`, `limit: number`, and `hasNext: boolean` as sibling keys of that array field** — checked against the real HTTP response bytes, not against the route's own OpenAPI-declared schema. Maintain an explicit exemption allowlist (empty as of this story — see D9/Open Questions for the one anticipated future entry, Story 8.2's cursor-paginated audit search) for any genuinely different pagination style; anything not on the allowlist must satisfy the page-based rule.

### D8 — Concrete FR97 gaps found by reading the current schemas (fixed by this story, not hypothetical)

Verified by direct source inspection (`grep`/`Read`, not inferred):

1. **`apps/api/src/modules/machine-users/schema.ts`'s `MachineUserListResponseSchema`** declares only `{ items, total }`. But `apps/api/src/modules/machine-users/routes.ts`'s `GET /:projectId/machine-users` handler (around line 300) already computes `...buildPaginationMeta(pagination, Number(total))` and spreads `page`/`limit`/`hasNext` into its return object — **the schema silently drops them from the wire response today** (D7's exact motivating bug). Fix: add `page: z.number().int().positive()`, `limit: z.number().int().positive()`, `hasNext: z.boolean()` to the schema, matching `apps/api/src/modules/credentials/schema.ts`'s already-correct `ListCredentialsResponseSchema` verbatim in shape.
2. **`apps/api/src/modules/projects/schema.ts`'s `ProjectListResponseSchema`** declares only `{ items, total }`, and **`apps/api/src/modules/projects/schema.ts`'s `ListProjectsQuerySchema`** accepts only `includeArchived` — no `page`/`limit` query params exist at all, and `apps/api/src/modules/projects/routes.ts`'s `GET ''` handler queries and returns every row for the org unbounded. Fix: add `...PageLimitQueryShape` (from `apps/api/src/lib/pagination.ts` — already exported, already used by `credentials`/`rotation`/`machine-users`) to `ListProjectsQuerySchema`; use `parsePagination()`/`paginationOffset()`/`buildPaginationMeta()` (same file) in the handler exactly as `credentials/routes.ts` does; add `page`/`limit`/`hasNext` to the response schema.
3. **`apps/api/src/modules/search/schema.ts`'s `SearchResponseSchema`** declares `{ results, total, query, types }` — no pagination fields. Fix: add `page`/`limit`/`hasNext` as siblings of `results`/`total` (keep the `results` field name — it is more semantically correct for a search endpoint than `items`, and D7's rule is explicitly field-name-agnostic for this reason; do not rename it). Add `page`/`limit` query params via `PageLimitQueryShape` to `SearchQuerySchema` if not already accepted server-side (verify at implementation time whether the search service already supports an offset internally before assuming new query-handling code is needed).
4. **`apps/api/src/modules/notifications/schema.ts`'s `GetInboxResponseSchema`** declares `{ data: array, page, limit }` — accepts `page`/`limit` query (`GetInboxQuerySchema`) and echoes them back, but is **missing `total` and `hasNext` entirely**, and its `data` field is a bare array rather than an object wrapping `items`. Fix: restructure to `{ data: { items: [...InboxEntrySchema], total, page, limit, hasNext } }` for consistency with every other collection endpoint in the codebase. **This is a confirmed breaking response-shape change with a real, already-existing web consumer — not a hypothetical, and not something to "double-check at implementation time":** `apps/web/src/lib/api/inbox.ts`'s `InboxListResponse` type is declared as `{ data: InboxEntry[]; page: number; limit: number }` (line 23), matching today's bare-array shape exactly, and `apps/web/src/routes/(app)/notifications/+page.server.ts`'s `load()` function (line 18) does `notifications: inbox.data` — i.e. it assigns the bare array directly, which would become `{ items, total, page, limit, hasNext }` (an object, not an array) the instant the API-side schema changes. **This story's scope must include updating both files in the same PR**: `apps/web/src/lib/api/inbox.ts`'s `InboxListResponse` type to the new nested shape, and `+page.server.ts`'s `load()` to read `inbox.data.items` (and optionally surface `inbox.data.total`/`inbox.data.hasNext` for future pagination UI) instead of `inbox.data`. This is a small, mechanical, same-PR fix — not a deferred follow-up — precisely because the consumer is real and was found by checking, not assumed absent.
5. **Already-compliant precedent — copy this shape, do not reinvent:** `apps/api/src/modules/credentials/schema.ts`'s `ListCredentialsResponseSchema`, `apps/api/src/modules/rotation/schema.ts`, `apps/api/src/modules/monitoring/schema.ts`, and `apps/api/src/modules/org/schema.ts` (all using `paginatedListMetaFields` from `apps/api/src/lib/api-contracts.ts` or the `PageLimitQueryShape`/`buildPaginationMeta()` pair from `apps/api/src/lib/pagination.ts`) are the working reference implementations FR97 already got right. This story's job on the pagination front is closing the four gaps above, not redesigning pagination from scratch.

**Note on sequencing relative to 9.1/9.2:** this story's *files* are disjoint from 9.1/9.2 (no shared schema or route module, so either can merge first without a file-level conflict). It is **not** fully independent in test-coverage terms, though: D6 point 3's contract suite feature-detects the platform-operator role 9.1/9.2 introduce and only exercises platform-operator-gated negative paths once that mechanism exists — see D6's "Sequencing note" for the exact mechanism. Do not read the "any order" framing above as "zero interaction whatsoever."

### D9 — Zero-downtime upgrades are explicitly out of scope and architecturally impossible in v1 — do not build a rolling/blue-green mechanism

`architecture.md`'s tier-limit-cache section documents a hard **single-instance constraint**: a startup guard rejects a second live API instance (`INSTANCE_COUNT`/`CLUSTER_MODE` env-var check, plus a DB-backed `api_instances` heartbeat check that exits the process with code 1 if another live instance is detected). This means `docker compose up -d` after pulling a new image **necessarily** stops the old `api` container before the new one can start (Compose's default recreate behavior) — there is a real, brief request-serving gap during every upgrade, by design, not by omission.

**Resolution:** this story's "in-place" guarantee is about **data and configuration preservation across the upgrade** (FR50's literal text: "preserve all data, secrets, audit logs, and configuration without requiring reinstallation") and **migration safety** (D1-D3) — it is explicitly **not** a zero-downtime guarantee, and no AC below should be read as requiring one. Do not add a second concurrently-running `api` container, health-check-gated traffic draining, or any blue-green mechanism — any of these would violate the single-instance architectural invariant and trigger the startup guard's own `exit(1)` safety check. State this explicitly in Dev Notes so a dev agent optimizing for "true" zero-downtime doesn't introduce a regression against an existing, deliberate architectural constraint.

---

## Acceptance Criteria

### AC-1 — Migrations run automatically as part of `docker compose up -d`; success path (D1)

**Given** a platform operator has pulled a new image tag and runs `docker compose up -d` against an existing, running deployment,
**When** Compose recreates the `migrate` one-shot service,
**Then** it runs `pnpm --filter @project-vault/db db:migrate` (D2's guarded wrapper) against the live database, applies any pending migrations, and exits 0 on success; the `api` service (which `depends_on: migrate: condition: service_completed_successfully`) only starts after `migrate` exits 0.

**Example (positive):** an operator on schema version 0035 upgrades to a build that adds migration `0036_new_additive_column.sql` (a new nullable column with a default). `docker compose up -d` output shows the `migrate` container logging the applied migration, exiting 0, then `api` starting normally; `curl http://localhost:3000/ready` returns `200 { "status": "ready" }` within the existing `start_period: 30s` health-check window.

**Example (edge — no pending migrations):** an operator re-runs `docker compose up -d` with no new image (e.g., to pick up an env var change) — `migrate` runs, finds zero pending migrations, exits 0 immediately (drizzle-kit's own no-op behavior, unchanged by this story), and `api` starts exactly as before.

---

### AC-2 — Migration failure aborts startup; `api` never serves traffic on a bad migration (D1)

**Given** a pending migration file contains invalid SQL (a genuine authoring bug, not a destructive-operation refusal — see AC-3 for that case) or the database connection fails during migration,
**When** `docker compose up -d` runs,
**Then** the `migrate` service exits non-zero, `api`'s `depends_on: condition: service_completed_successfully` is never satisfied, and `api` does not start — `docker compose ps` shows `api` in a state that never reached `running`, and `docker compose logs migrate` shows the SQL error.

**Example (positive):** a syntactically invalid migration (e.g., referencing a nonexistent column in a `CREATE INDEX`) causes `drizzle-kit migrate` to exit non-zero; `docker compose up -d` output ends with the `migrate` container's exit code visible and `api` absent from `docker compose ps`'s running services.

**Example (edge — operator retries after fixing the migration):** the operator corrects the migration file, rebuilds the image, and re-runs `docker compose up -d`; `migrate` re-runs from the same not-yet-applied point (drizzle-kit's journal correctly tracks which migrations already succeeded vs. which are still pending) — already-applied earlier migrations are not re-run or re-checked for the fixed error.

---

### AC-3 — Destructive migrations are refused in auto-migrate mode; `--allow-destructive` is the only bypass (D2, AC-E9b)

**Given** a pending migration file contains a `DROP COLUMN`, `DROP TABLE`, `RENAME COLUMN`, or table `RENAME TO` statement,
**When** `pnpm --filter @project-vault/db db:migrate` runs without `--allow-destructive`,
**Then** the guarded wrapper (D2) detects the destructive statement(s) via `findDestructiveStatements()`, logs a structured error naming the offending file and statement, and exits 1 **without invoking `drizzle-kit migrate` at all** — the database is left completely untouched (not even the safe/additive migrations bundled in the same batch are applied, to avoid a partially-applied release where some pending migrations succeeded and the destructive one silently didn't).

**Example (positive — refused):**
```
$ pnpm --filter @project-vault/db db:migrate
FATAL: migration 0036_drop_legacy_column.sql contains a destructive operation:
  DROP COLUMN "legacy_field" (line 3)
In-place auto-migration refuses destructive schema changes (AC-E9b).
Follow the documented offline migration procedure (see docs/runbook.md § Upgrades),
or re-run with --allow-destructive if you have already completed that procedure.
$ echo $?
1
```

**Example (positive — explicit bypass):** `pnpm --filter @project-vault/db db:migrate --allow-destructive` on the same pending migration proceeds to invoke `drizzle-kit migrate` normally and applies it.

**Example (edge — mixed batch, one destructive):** three pending migrations are queued; only the third contains `DROP COLUMN`. Without the flag, the wrapper refuses **before running any of the three** (the safe-by-default posture: an operator should not end up in a state where migrations 1-2 silently applied but 3 didn't, without being told clearly that the whole batch was blocked).

**Example (negative — false positive check, identifier substring):** a pending migration contains `ADD COLUMN "renamed_email" text` (a column whose *name* contains the substring "rename" but is not a `RENAME` statement) — the regex-based scan must not flag this; only actual keyword matches (from D2's full expanded pattern list) trigger refusal, not incidental substring matches in identifiers.

**Example (negative — false positive check, comment/string-literal context):** a pending migration contains the line `-- TODO: consider a future DROP COLUMN cleanup of this deprecated field` (a SQL comment mentioning the keyword) or a data-migration statement like `UPDATE settings SET value = 'legacy DROP COLUMN behavior disabled' WHERE key = 'flag'` (the keyword appears only inside a string literal) — D2's comment/string-stripping preprocessing step must strip both before the keyword scan runs, so neither line triggers a refusal.

---

### AC-4 — `migration-compatibility-check.ts` CI gate scans full migration history, not just pending files (D3)

**Given** the full set of committed migration files under `packages/db/src/migrations/`,
**When** `pnpm check-migration-compatibility` runs (no database connection required),
**Then** it scans every `.sql` file (applied or not) for destructive statements and exits non-zero, listing every offending file, if any are found; it exits 0 if none are found.

**Example (positive — current `main`):** run against the 35 existing migrations (`0000_initial_schema.sql` through `0035_rotations_status_initiated_org_id.sql`) — exits 0 immediately; none contain destructive statements (verified fact, D3).

**Example (negative — new destructive PR):** a contributor opens a PR adding `0036_oops_drop_column.sql` containing `ALTER TABLE credentials DROP COLUMN notes;` — CI's `Check migration compatibility` step fails with a message identifying `0036_oops_drop_column.sql` and the exact line, blocking merge until either the migration is rewritten additively or an `--allow-destructive`-equivalent human sign-off process (Story 9.5's offline procedure) is followed and documented in the PR.

**Example (edge — the check itself needs no DB):** the CI step runs successfully even if the `postgres` service container in the same job were entirely removed — it is a pure static file scan, verifying the "no live DB required" design goal explicitly.

---

### AC-5 — Generated OpenAPI spec covers the real registered route surface, not a hand-maintained subset (D4)

**Given** all ~20 route modules registered in `apps/api/src/app.ts`,
**When** `pnpm generate-spec` runs,
**Then** `packages/shared/openapi.json`'s `paths` object contains an entry for every registered route across every module (credentials, rotation, monitoring, machine-users, audit, admin, projects, search, notifications, dashboard, vault, org, invitations, onboarding, users, health-dashboard, status-pages) — not the previous 8-path stub.

**Example (positive):** after the D4 rewrite, `packages/shared/openapi.json`'s `Object.keys(paths).length` is well over 60 (the regression test's floor, D4 point 5) — verified manually at implementation time against `apps/api/src/app.ts`'s full registration list to confirm no module was accidentally skipped.

**Example (edge — a new route is added later without running generate-spec):** a future PR adds a new route but forgets to re-run `pnpm generate-spec` before committing — CI's existing "Generate spec and check freshness" step's `git diff --exit-code packages/shared/openapi.json` now genuinely catches this (previously it was a no-op self-consistency check against the static stub; post-D4 it is a real diff against the live registered surface).

**Example (regression guard — accidental stub reversion):** the new `generate-spec.test.ts` (D4 point 5) fails loudly if a future refactor accidentally reverts `generate-spec.ts` to a hardcoded literal, since the path count would drop back to single digits.

---

### AC-6 — `GET /api/v1/openapi.json` serves the live spec (D5)

**Given** `ENABLE_API_DOCS=true`, or `NODE_ENV` is `development` or `test` (D5's fail-closed allowlist),
**When** a client calls `GET /api/v1/openapi.json`,
**Then** it returns `200` with the exact same JSON `fastify.swagger()` produces (the same object written to `packages/shared/openapi.json` at build time — this route reflects the live-running instance's registered routes, which in a correctly-deployed instance always matches the committed file per AC-5's freshness check).

**Example (positive):** `curl http://localhost:3000/api/v1/openapi.json | jq '.paths | keys | length'` returns the same count as `packages/shared/openapi.json`.

**Example (edge — gated off in production):** with `NODE_ENV=production` and `ENABLE_API_DOCS` unset (default `false`), `GET /api/v1/openapi.json` returns `404` — the route is not registered at all, not merely access-controlled, so its absence carries no information leak about whether docs exist.

---

### AC-7 — `GET /api/v1/docs` serves Swagger UI (D5)

**Given** the same gating condition as AC-6,
**When** a developer navigates to `GET /api/v1/docs` in a browser,
**Then** they see the `@fastify/swagger-ui`-rendered interactive Swagger UI, backed by the same live spec as AC-6, allowing them to browse every documented endpoint's request/response schemas and try requests (subject to their own auth cookie/token).

**Example (positive):** in a local dev environment (`NODE_ENV=development`), `GET /api/v1/docs` returns `200 text/html` and renders correctly; the "Try it out" feature against `GET /api/v1/auth/me` with a valid session cookie returns a live `200` response matching the documented schema.

**Example (edge — production default):** with `NODE_ENV=production` and `ENABLE_API_DOCS` unset, `GET /api/v1/docs` returns `404`, same as AC-6.

---

### AC-8 — Contract test suite enumerates every documented route (D6)

**Given** the freshly-generated `packages/shared/openapi.json` (D4/AC-5),
**When** `pnpm --filter @project-vault/api-contract-tests test` runs,
**Then** it programmatically loads every `path`+`method` combination from the spec's `paths` object and generates one test case per combination — no route is hardcoded into a fixed list that could silently go stale as new routes are added (a maintenance-checklist anti-pattern the story must avoid, per AC-E9a's explicit "manual parity checklist is not acceptable").

**Example (positive):** the suite's own summary output states the number of route/method combinations tested (e.g., "62 operations tested"), which naturally grows as future stories add routes and re-run `generate-spec` — no code change to the contract-test suite itself is required when new routes are added elsewhere.

**Example (edge — a route registered but never given a response schema):** if a future developer registers a raw Fastify route bypassing `@fastify/type-provider-zod`'s schema declaration entirely, `@fastify/swagger` would either omit it from the spec or document it with an empty/generic schema — either way this is caught by the existing `route-audit.test.ts`'s unrelated SecureRoute-marker check (every route must go through `secureRoute()`, which always declares a schema in this codebase's established pattern) rather than something this story's suite needs to separately guard against; document this boundary explicitly in this package's README to avoid duplicate-purpose test suites.

---

### AC-9 — Contract test suite verifies each response against its documented schema, using real auth (D6)

**Given** the enumerated operations (AC-8),
**When** each is invoked via `app.inject()` with a bootstrapped session appropriate to its documented `security` requirement (platform operator, org member, or unauthenticated, per the route's actual `SecureRoute` configuration),
**Then** the actual response status code is one the OpenAPI spec documents for that operation, and the response body validates (via `ajv`) against that status's documented JSON schema.

**Example (positive):** `GET /api/v1/projects` invoked with a valid org-member session returns `200`, and the body validates against `ProjectListResponseSchema`'s JSON-schema representation (post-D8 fix, including `page`/`limit`/`hasNext`).

**Example (negative — undocumented status code surfaced):** if a route were to return a `500` for a case the spec doesn't document as a possible response (e.g., an unhandled exception on a code path the developer didn't anticipate), the contract test for that operation fails, flagging either a missing error-schema declaration or a real bug — this is a genuine, valuable failure mode this suite is designed to surface, not a false positive to suppress.

**Example (edge — write endpoints are exercised idempotently or with cleanup):** POST/PUT/DELETE operations (e.g., `POST /api/v1/projects`) use fixture payloads that create disposable test rows in the isolated test org created for this suite's run (reusing `withTestOrg()`-style teardown, D6 point 3) — the suite must not depend on production-scale data or leave orphaned rows that would break re-runs.

---

### AC-10 — Contract test suite is a required CI check (D6, AC-E9a blocker)

**Given** a pull request that changes any route's request/response shape without updating the corresponding handler (or vice versa),
**When** CI runs,
**Then** the `API contract parity tests` step (or the `pnpm turbo test` step, whichever the implementer wires it into per D6 point 4) fails, blocking merge — this is a required check, not an optional/advisory one, satisfying AC-E9a's explicit "manual checklist parity is not acceptable for sign-off" language.

**Example (positive — the check blocks a real regression):** a hypothetical future PR changes `ListCredentialsResponseSchema` to rename `items` to `credentials` without updating the contract test's generic expectations — since AC-9's check is schema-driven (it validates against whatever schema the spec currently documents, not a hardcoded field-name list), this particular rename would actually **pass** schema conformance (the schema and the response agree with each other) — this is expected and correct: schema-conformance alone cannot catch a deliberate, coordinated rename. It is D7's *independent* pagination-field rule (AC-11 below), not schema conformance, that would need to also pass — demonstrating why both checks are necessary and neither subsumes the other.

**Example (negative — genuine schema/handler drift):** a future PR adds a new required field to `CreateProjectBodySchema` but forgets to update the route handler to read it, causing a runtime `undefined` where a value was expected — the contract test's fixture payload (built from the OpenAPI schema's `required` fields) triggers this immediately.

---

### AC-11 — All collection endpoints expose `page`/`limit`/`total`/`hasNext` in the actual response body (D7, D8, FR97)

**Given** every collection-shaped endpoint identified by D7's array-field heuristic,
**When** the contract test suite's independent pagination-field check (D7) runs against each,
**Then** the actual parsed JSON response (not the declared schema) contains `total: number`, `page: number`, `limit: number`, `hasNext: boolean` as siblings of the array field, for all of: `GET /api/v1/projects/:id/credentials` (already compliant), `GET /api/v1/projects` (fixed, D8.2), `GET /api/v1/search` (fixed, D8.3), `GET /api/v1/notifications/inbox` (fixed, D8.4), `GET /api/v1/projects/:id/machine-users` (fixed, D8.1), and every other module already using `paginatedListMetaFields`/`buildPaginationMeta` (rotation, monitoring, org).

**Example (positive — the D8.1 bug, now fixed):** `GET /api/v1/projects/:projectId/machine-users` returns `{ data: { items: [...], total: 3, page: 1, limit: 20, hasNext: false } }` — previously (pre-fix) the same handler computed this exact object internally but the wire response omitted `page`/`limit`/`hasNext` due to the response schema silently stripping them (D7).

**Example (positive — `GET /api/v1/projects`, previously fully unpaginated):** `GET /api/v1/projects?page=1&limit=20` now returns `{ data: { items: [...], total: 7, page: 1, limit: 20, hasNext: false } }`; calling the same endpoint with no query params at all still works (defaults `page=1&limit=20`, per `PageLimitQueryShape`), preserving backward compatibility for any existing caller that never sent pagination params.

**Example (edge — a genuinely non-array collection response is correctly exempt):** `GET /api/v1/auth/me` returns a single session object (`data: { userId, orgId, ... }`), not an array — D7's heuristic correctly does not apply the pagination-field rule here, since there is no array-typed field in its `data` object.

---

### AC-12 — Pagination query parameters are consistently bounded (`limit` max 100, default 20; `page` default 1) across all fixed and pre-existing endpoints (D8, FR97)

**Given** any collection endpoint using `PageLimitQueryShape`,
**When** a client omits `page`/`limit`, supplies valid values, or supplies an out-of-range `limit`,
**Then** behavior is consistent: omitted values default to `page=1`/`limit=20`; `limit` above 100 is rejected or clamped consistently with the existing convention already established by `credentials`/`rotation`/`machine-users` (verify at implementation time which of "clamp" vs. "422 reject" `PageLimitQueryShape`'s `.max(100)` Zod validator actually produces — Zod's `.max()` on a number rejects with a validation error rather than silently clamping; confirm the newly-fixed endpoints (`projects`, `search`, `notifications`) match this exact behavior rather than inventing a different clamping convention for consistency's sake).

**Example (positive):** `GET /api/v1/projects?limit=150` returns `422 { "code": "validation_error", ... }` (Zod's `.max(100)` rejection), matching `GET /api/v1/projects/:id/credentials?limit=150`'s existing identical behavior.

**Example (edge — `page` beyond available data):** `GET /api/v1/projects?page=999&limit=20` on an org with only 3 projects returns `200 { data: { items: [], total: 3, page: 999, limit: 20, hasNext: false } }` — an empty page is a valid, well-formed response, not an error (consistent with `credentials`'s existing behavior for the same case, which does not error on an out-of-range page the way a cursor-offset-limited endpoint like `credentials`'s own `PAGE_OUT_OF_RANGE_ERROR` guard does for *very* deep pages — verify whether `projects`/`search`/`notifications` need the same `resolvePaginationOffset`/`MAX_*_LIST_OFFSET` deep-offset guard `credentials` has, given `credentials.ts`'s existing convention protects against expensive deep-`OFFSET` queries; apply the same guard to `projects` if the underlying query pattern is the same `OFFSET`-based approach, since the risk is identical).

---

### AC-13 — Response-schema vs. actual-response drift is caught even when the schema is internally self-consistent (D7)

**Given** a hypothetical route whose Zod response schema and handler output happen to agree with each other but both omit a field FR97 requires,
**When** the contract test suite's D7 check runs,
**Then** it fails — because D7's check inspects the actual wire response independent of what the schema declares, catching cases that a "does response match schema" check alone would pass.

**Example (positive — proves the independence, using the pre-fix machine-users case as the historical example):** before this story's fixes, `MachineUserListResponseSchema` declared `{ items, total }` and the actual (Zod-stripped) response also only contained `{ items, total }` — these agree with each other perfectly (schema conformance passes), yet D7's independent array-plus-pagination-fields rule correctly flags this as a failure, because the actual response is missing `page`/`limit`/`hasNext` regardless of whether the schema "expected" them.

**Example (negative — false-flagging a correctly-exempt endpoint):** verify the D7 check does not fire against `GET /api/v1/auth/sessions` (returns an array of session objects with no `total`/pagination concept — a small, unbounded-by-design list scoped to "this user's own active sessions," which realistically never exceeds single digits) — either add this specific route to D7's exemption allowlist with a one-line justification comment, or confirm its response shape doesn't structurally match the "array nested inside a `data` object" heuristic (if `GET /auth/sessions` returns `{ data: [...] }` directly rather than `{ data: { items: [...] } }`, the heuristic as scoped in D7 — "an array-typed **property** of the `data` object" — correctly does not match a bare top-level array and needs no exemption entry at all; confirm which shape this endpoint actually uses at implementation time and document the outcome).

---

### AC-14 — `generate-spec` requires no live database connection, in CI or locally (D4)

**Given** a machine with no Postgres reachable at all (no Docker running, no `DATABASE_URL` pointing at a live server),
**When** `pnpm generate-spec` runs,
**Then** it completes successfully — proving the D4 design goal that spec generation is a pure, DB-free, offline-capable operation.

**Example (positive):** `docker stop <postgres-container>` (or simply never starting one), then `DATABASE_URL= pnpm --filter @project-vault/api generate-spec` (no env override at all) still succeeds, because the script sets its own safe placeholder values internally (D4 point 1) and never issues a query.

**Example (regression guard):** a future refactor that accidentally makes `generate-spec.ts` call any function that issues a real query (e.g., a route's `onReady` hook that eagerly warms a cache via a DB read) would cause this exact scenario to hang or fail with a connection-refused error — add a short comment at the top of `generate-spec.ts` warning against introducing eager DB I/O during route registration, referencing this AC.

---

### AC-15 — Contract test suite itself respects authorization boundaries — documented 401/403 responses are exercised, not skipped (D6)

**Given** routes documented with `401`/`403` responses for missing/insufficient authorization (e.g., platform-operator-only routes once Stories 9.1/9.2 land, or org-role-gated routes that already exist today),
**When** the contract suite runs each such operation twice — once with no session, once with a session that has insufficient privilege for that specific route —
**Then** both documented negative-path responses are exercised and validated against their documented schemas, not merely the happy-path 2xx case.

**Example (positive):** `DELETE /api/v1/projects/:projectId` (owner/admin-gated) invoked with a `viewer`-role session returns `403`, and the body validates against the documented `403` response schema (`ApiErrorSchema`).

**Example (edge — routes with no negative-path documentation yet):** if a given route's spec entry only documents `200`/`401` but not `403` (because, at the time it was written, every authenticated user could reach it regardless of role), the suite does not fabricate a `403` test case for it — it only exercises what the spec actually documents, since AC-8 already establishes "enumerate what the spec says exists," not "enumerate every theoretically possible auth failure mode."

---

### AC-22 — Contract test suite asserts cross-tenant (RLS) isolation on org-scoped resource-fetch routes (D6 point 3(g))

*(Numbered 22 rather than inserted as 15b/16 to avoid renumbering every downstream cross-reference to AC-16 through AC-21; placed here, next to AC-15, because it is a sibling authorization-boundary check, not because of numeric sequence. Added during adversarial-review remediation — see the story's adversarial-review file.)*

**Given** two fully separate orgs bootstrapped via real register/login flows ("org A" and "org B", D6 point 3(d)), each with at least one resource created via the same suite (e.g. a project, and a credential within it),

**When** the contract suite invokes a representative org-scoped, resource-by-ID GET route (at minimum: `GET /api/v1/projects/:projectId`, `GET /api/v1/projects/:projectId/credentials/:credentialId`, and `GET /api/v1/projects/:projectId/machine-users/:machineUserId` if a machine user fixture exists) using **org B's** authenticated session but **org A's** real resource ID,

**Then** the response is the route's documented not-found/forbidden status for an inaccessible resource (`404` if the route intentionally does not distinguish "doesn't exist" from "not yours" — the common, information-leak-minimizing convention elsewhere in this codebase — or `403` if the route's spec documents that instead), and the response body never contains org A's actual resource data.

**Example (positive):** org B's session calling `GET /api/v1/projects/:orgAProjectId` (a real, existing project ID belonging to org A) receives `404 { "code": "not_found" }` — not `200` with org A's project name/fields, and not a `500` from an unhandled RLS-policy edge case.

**Example (negative — the check this AC exists to catch):** if a route's handler queried by resource ID alone without also scoping the query to the caller's `orgId` (an RLS policy gap or a hand-rolled query that bypasses the org-scoped repository helper), org B's session would receive `200` with org A's real data — this AC's assertion fails loudly in that case, which is the intended, valuable failure mode.

**Example (edge — a route with no natural cross-org fixture, e.g. a truly global/platform-level resource):** if a specific route has no org-scoped concept at all (rare — most of this API is org-scoped by design), it is exempt from this AC's fixture-based check by virtue of not fitting the "org-scoped resource-by-ID" shape; document any such exemption inline in the suite's fixture-generation code with a one-line rationale, the same convention as D7's pagination-exemption allowlist.

---

### AC-16 — Sealed-vault guard applies to migration-adjacent and docs routes correctly (cross-reference to existing invariant)

**Given** the vault is sealed,
**When** `GET /api/v1/openapi.json` or `GET /api/v1/docs` is requested,
**Then** these routes are **not** gated by the vault-seal guard (`vaultGuardEnabled`) — they must remain reachable even while sealed, the same way `/health`/`/ready`/`/metrics` and the pre-auth vault-init/unseal routes are already exempted (`apps/api/src/__tests__/route-audit.test.ts`'s `EXEMPT_PATHS` set) — an operator diagnosing a sealed vault needs to be able to consult the API docs without first unsealing.

**Example (positive):** with the vault sealed, `curl http://localhost:3000/api/v1/openapi.json` (docs enabled) still returns `200` with the full spec, not a `503 { "code": "sealed" }`.

**Example (edge — regression guard):** extend `route-audit.test.ts`'s `EXEMPT_PATHS` set (or its equivalent classification mechanism) to include `/api/v1/openapi.json` and `/api/v1/docs` explicitly, with a one-line comment explaining why (docs must be sealed-vault-reachable, same rationale as `/health`), so a future refactor doesn't accidentally wrap these in `vaultGuardEnabled` and silently break operator diagnostics during an incident.

---

### AC-17 — Migration-safety decisions are logged as structured operational events, not silently swallowed (D2)

**Given** `guarded-migrate.ts` either refuses a destructive migration or proceeds (with or without `--allow-destructive`),
**When** either path executes,
**Then** it emits a structured pino-style log line (this runs pre-vault-unseal, in a one-shot container with no org/audit context available — this is an **operational** log, not an `audit_log_entries` row, consistent with how every other pre-auth/infra-level event in this codebase is logged) including: `event` (e.g., `migration.destructive_refused` / `migration.destructive_allowed` / `migration.applied`), the migration filename(s), and (for the `_allowed` case) a flag confirming `--allow-destructive` was explicitly passed.

**Example (positive):** `docker compose logs migrate` on a refused migration shows a single structured JSON line: `{ "event": "migration.destructive_refused", "level": "error", "file": "0036_drop_legacy_column.sql", "statements": ["DROP COLUMN \"legacy_field\""] }`.

**Example (edge — successful additive migration, routine case):** a normal additive migration still logs an `info`-level `migration.applied` event listing the filenames applied, so `docker compose logs migrate` always shows what happened even in the unremarkable, everyday case — not just on refusal.

---

### AC-18 — Retroactive compatibility of all pre-existing migrations (D3, backward compatibility)

**Given** the full history of 35 migrations shipped by Epics 1-8,
**When** `pnpm check-migration-compatibility` runs against them,
**Then** it passes with zero findings — proving this story's guard does not retroactively "break" CI for any already-merged, already-production-deployed migration.

**Example (positive):** this is the actual, verified state of `main` as of this story's creation (D3) — no migration-file edits are needed to make this AC pass; it documents an already-true fact so a future contributor doesn't waste time "fixing" a false-positive that doesn't exist.

**Example (edge — verified, not hypothetical):** despite its filename, `0017_credential_dependency_notes_len.sql` does **not** contain an `ALTER COLUMN ... TYPE` statement at all — it enforces its length limit via `ADD CONSTRAINT ... CHECK (char_length(notes) <= 2048)`, which is unaffected by any pattern in D2's scope (it is neither a column-type change nor a drop/rename). Two migrations do use `ALTER COLUMN ... SET NOT NULL` (`0007_session_revocation.sql`, `0012_refresh_tokens_org_id.sql`) — this is a `SET NOT NULL`, not a `TYPE` change, so it is also outside D2's expanded scope as written (D2 flags `ALTER COLUMN ... TYPE`, not `ALTER COLUMN ... SET NOT NULL`) and does not retroactively fail this check; this exact statement class is intentionally excluded from D2's scope for this story to keep the retroactive-compatibility guarantee zero-changes-required. If a future story wants to also flag `SET NOT NULL` on existing columns (a similar backfill-failure risk to `ADD COLUMN ... NOT NULL` without a default), that would need to grandfather these two historical migrations explicitly — out of scope here.

**Example (edge — the new conservative `ALTER COLUMN ... TYPE` rule, by design):** unlike the pre-fix scope, D2's expanded scope flags **every** `ALTER COLUMN ... TYPE` statement, including safe widening changes — this is intentional over-flagging (D2 point 1), not a bug to fix; verify at implementation time that a synthetic widening-only fixture (e.g. `varchar(50)` → `varchar(200)`) is still correctly flagged as requiring `--allow-destructive`, confirming the conservative design actually behaves as documented rather than silently narrowing back down to only unsafe cases.

---

### AC-19 — OpenAPI spec metadata reflects the real package version, not a permanently hardcoded placeholder

**Given** `apps/api/package.json`'s `version` field,
**When** `pnpm generate-spec` runs,
**Then** the generated spec's `info.version` is read from `apps/api/package.json` at generation time (e.g., via `JSON.parse(readFileSync(...))`) rather than the hardcoded literal `'0.0.1'` currently baked into both the stub `generate-spec.ts` and `app.ts`'s `swagger` plugin registration options — this is a small but real "finalized OpenAPI spec" quality bar (epics.md's Epic 9 preamble: "a verified complete versioned REST API with finalized OpenAPI spec").

**Example (positive):** bumping `apps/api/package.json`'s `version` to `0.1.0` and re-running `pnpm generate-spec` produces a spec with `info.version: "0.1.0"` with zero other code changes.

**Example (edge — `app.ts`'s own swagger registration and `generate-spec.ts` must agree):** since both the live `GET /api/v1/openapi.json` route (D5, backed by the same running app's `fastify.swagger()`) and the build-time `generate-spec.ts` script ultimately call the same `createApp()` → `@fastify/swagger` pipeline, fixing the version source in one place (`app.ts`'s swagger registration options) automatically fixes both — do not duplicate the version-reading logic in `generate-spec.ts` separately.

---

### AC-20 — `--allow-destructive` cross-references the offline migration procedure (Story 9.5), not left as an undocumented escape hatch

**Given** an operator who needs to run a destructive migration (a genuine, rare, intentional schema change),
**When** they consult the error message from AC-3's refusal,
**Then** it points them to `docs/runbook.md § Upgrades` (Story 9.5's deliverable) for the documented offline migration procedure — this story does not need to write that procedure itself (9.5's explicit scope: *"How to identify if a migration is destructive (run `pnpm migration-compatibility-check`) and the offline migration path"*), but the error message and this story's own Dev Notes must reference the exact path Story 9.5 is expected to fill in, so the two stories compose correctly regardless of implementation order.

**Example (positive):** the refusal message (AC-3) literally includes the string `docs/runbook.md § Upgrades` — grep-able cross-reference, verified by a test asserting the error message contains that exact substring.

**Example (edge — Story 9.5 not yet written when this story ships):** if `docs/runbook.md` does not yet exist (Story 9.5 is `backlog` as of this story's creation), the error message still references the expected future path — this is a forward-reference, not a broken link requiring this story to stub out runbook content; flag this explicitly for Story 9.5's author when that story is written (Open Question 1 below).

---

## Tasks / Subtasks

- [ ] **Task 1 — Migration safety helper + guarded wrapper (D2)**
  - [ ] `packages/db/src/lib/migration-safety.ts` — `findDestructiveStatements(sql: string): string[]`, with a comment/string-literal-stripping preprocessing step and the full expanded pattern set (`DROP COLUMN`, `DROP TABLE`, `RENAME COLUMN`, `RENAME TO`, `TRUNCATE`, `DELETE FROM`, `DROP CONSTRAINT`, `DROP DEFAULT`, `ALTER COLUMN ... TYPE`, `ADD COLUMN ... NOT NULL` without `DEFAULT`)
  - [ ] `packages/db/src/scripts/guarded-migrate.ts` — reads drizzle-kit's journal for pending migrations, scans via the helper, refuses (exit 1, no DB touched) unless `--allow-destructive`, otherwise shells out to `drizzle-kit migrate`
  - [ ] `packages/db/package.json`'s `db:migrate` script → `tsx src/scripts/guarded-migrate.ts` (no `docker-compose.yml` changes needed, D1/D2)
  - [ ] Structured operational log events on refuse/allow/apply (AC-17)
- [ ] **Task 2 — CI migration-compatibility gate (D3)**
  - [ ] Export `findDestructiveStatements` from `packages/db`'s public entry point (reuse, do not duplicate — jscpd gate)
  - [ ] Root `scripts/migration-compatibility-check.ts` — full-history scan, no DB connection
  - [ ] Root `package.json` script `check-migration-compatibility`; new CI step in `.github/workflows/ci.yml`
  - [ ] Verify it passes against all 35 existing migrations with zero changes, including against the expanded pattern set (AC-4, AC-18)
- [ ] **Task 3 — Real OpenAPI generation (D4)**
  - [ ] Rewrite `apps/api/src/scripts/generate-spec.ts`: safe env placeholders → `createApp({ logger: false })` → `app.ready()` → `app.swagger()` → write `packages/shared/openapi.json` → `app.close()`
  - [ ] `apps/api/package.json`'s `version` sourced into `app.ts`'s swagger registration `info.version` (AC-19)
  - [ ] Regression test asserting path count floor (AC-5)
  - [ ] Manually verify every module in `apps/api/src/app.ts`'s registration list appears in the generated spec
- [ ] **Task 4 — Swagger UI + live spec route (D5)**
  - [ ] Add `@fastify/swagger-ui` dependency; register in `app.ts` with `routePrefix: '/api/v1/docs'`
  - [ ] New `GET /api/v1/openapi.json` route (`apps/api/src/routes/openapi.ts` or similar)
  - [ ] Gate both behind `ENABLE_API_DOCS === true || NODE_ENV === 'development' || NODE_ENV === 'test'` (fail-closed allowlist, not a `!== 'production'` negation); document `ENABLE_API_DOCS` in `.env.example`
  - [ ] Extend `route-audit.test.ts`'s exemption set to cover both new routes, with the sealed-vault-reachability rationale (AC-16)
- [ ] **Task 5 — Contract test suite package (D6)**
  - [ ] New `packages/api-contract-tests` workspace package (`package.json`, `tsconfig.json`)
  - [ ] Auth-bootstrap helper: register + login flows for two separate orgs (org A, org B), each with org-member and org-admin sessions, plus a feature-detected platform-operator session (skip with a logged note if the mechanism doesn't exist yet — see D6's sequencing note) via real `app.inject()` calls
  - [ ] OpenAPI-driven test generation: enumerate `paths` from `packages/shared/openapi.json`, one case per operation
  - [ ] Per-operation: status-code + `ajv` schema validation against the documented response (AC-9)
  - [ ] Negative-path cases: exercise documented `401`/`403` responses, not just `2xx` (AC-15)
  - [ ] Cross-tenant isolation cases: org B's session against org A's resource IDs on representative org-scoped GET routes (AC-22)
  - [ ] Independent FR97 pagination-field check (D7) — array-in-`data` heuristic + exemption allowlist
  - [ ] `turbo.json` task entry; new CI step `API contract parity tests` after the "Generate spec and check freshness" step
- [ ] **Task 6 — Pagination hardening fixes (D8)**
  - [ ] `machine-users/schema.ts`: add `page`/`limit`/`hasNext` to `MachineUserListResponseSchema` (bug fix — fields already computed by the handler, just not declared)
  - [ ] `projects/schema.ts` + `projects/routes.ts`: add `PageLimitQueryShape` to `ListProjectsQuerySchema`; use `parsePagination`/`paginationOffset`/`buildPaginationMeta`; add `page`/`limit`/`hasNext` to `ProjectListResponseSchema`
  - [ ] `search/schema.ts` + `search/routes.ts`: add `page`/`limit`/`hasNext` to `SearchResponseSchema`; verify/add query-param + offset handling in the search service
  - [ ] `notifications/schema.ts` + `notifications/routes.ts`: restructure `GetInboxResponseSchema` to `{ data: { items, total, page, limit, hasNext } }`
  - [ ] `apps/web/src/lib/api/inbox.ts`: update `InboxListResponse` type to the new nested shape (confirmed real consumer of the old bare-array shape — see D8.4)
  - [ ] `apps/web/src/routes/(app)/notifications/+page.server.ts`: update `load()` to read `inbox.data.items` instead of `inbox.data`
- [ ] **Task 7 — Documentation cross-references**
  - [ ] Ensure AC-3/AC-20's refusal message references `docs/runbook.md § Upgrades` (forward-reference, Story 9.5)
  - [ ] `.env.example`: document `ENABLE_API_DOCS`
- [ ] **Task 8 — Full integration test pass (see explicit list below)**

### AC-21 — Integration test coverage (explicit list — do not consider this story done without all of these)

**Given** the full feature set above,
**When** the test suites run (`packages/db/src/**/*.test.ts`, `apps/api/src/**/*.test.ts`, `apps/api/src/scripts/generate-spec.test.ts`, `packages/api-contract-tests/`),
**Then** it covers, at minimum: (1) `findDestructiveStatements()` unit tests for each of the expanded set of detected patterns (`DROP COLUMN`, `DROP TABLE`, `RENAME COLUMN`, `RENAME TO`, `TRUNCATE`, `DELETE FROM`, `DROP CONSTRAINT`, `DROP DEFAULT`, `ALTER COLUMN ... TYPE`, `ADD COLUMN ... NOT NULL` without `DEFAULT`) plus false-positive cases, including a destructive keyword appearing only inside a SQL comment or string literal correctly NOT flagged (AC-3); (2) `guarded-migrate.ts` refuses without touching the DB, and proceeds with `--allow-destructive` (AC-3); (3) mixed-batch refusal behavior (AC-3); (4) `migration-compatibility-check.ts` passes against all 35 existing migrations (against the expanded pattern set) and fails against a synthetic destructive fixture for each new pattern (AC-4, AC-18); (5) generated spec path-count floor and module-coverage spot-check (AC-5); (6) `generate-spec` succeeds with no `DATABASE_URL`/live Postgres (AC-14); (7) `GET /api/v1/openapi.json` and `GET /api/v1/docs` reachable when enabled, `404` when gated off (including for an unset/non-canonical `NODE_ENV`-adjacent misconfiguration, verifying the fail-closed default), and reachable while sealed (AC-6, AC-7, AC-16); (8) contract suite enumerates all operations and passes against current routes (AC-8, AC-9); (9) contract suite catches a deliberately-reintroduced version of the machine-users bug in a scratch test (AC-11, AC-13 — a temporary, deliberately-broken schema used only to prove the check's sensitivity, then reverted); (10) all four D8 pagination fixes (`machine-users`, `projects`, `search`, `notifications`) return complete `page`/`limit`/`total`/`hasNext` (AC-11, AC-12); (11) `limit` bound (max 100) enforced consistently on all four (AC-12); (12) contract suite exercises documented `401`/`403` paths (AC-15); (13) operational log events emitted on migration refuse/allow/apply (AC-17); (14) OpenAPI `info.version` reflects `package.json` (AC-19); (15) AC-3's refusal message contains the runbook cross-reference string (AC-20); (16) `apps/web`'s updated `inbox.ts`/`+page.server.ts` correctly read the new nested inbox response shape (D8.4); (17) contract suite's cross-tenant isolation check correctly rejects org B's session reading org A's resources across all three representative routes (AC-22).

---

## Dev Notes

### Architecture Compliance

- Preserves the existing one-shot `migrate`-service Compose architecture (D1) rather than relocating migration execution into `apps/api`'s own startup — do not touch `apps/api/src/main.ts`'s startup sequence for this story.
- Reuses `createApp()` — the exact same factory every existing integration test already calls — for both the OpenAPI generation script (D4) and the contract test suite (D6), rather than inventing a second app-construction path.
- Reuses `apps/api/src/lib/pagination.ts`'s `PageLimitQueryShape`/`parsePagination`/`paginationOffset`/`buildPaginationMeta` for every D8 fix — these already exist and are already the correct, working pattern (`credentials`, `rotation` modules use them today); do not invent a second pagination helper.
- **Zero-downtime is explicitly out of scope (D9)** — do not build a rolling/blue-green upgrade mechanism; it would violate the documented single-instance architectural constraint (`architecture.md`'s startup multi-instance guard).
- The contract test suite (D6) intentionally uses `app.inject()`, not a bound HTTP server or `docker compose up` — this is a deliberate interpretation of epics.md's "against a running instance" language, consistent with every existing integration test's own convention in this codebase.

### Project Structure Notes

- New files: `packages/db/src/lib/migration-safety.ts`, `packages/db/src/scripts/guarded-migrate.ts`, root `scripts/migration-compatibility-check.ts`, `apps/api/src/routes/openapi.ts` (or equivalent), new workspace package `packages/api-contract-tests/` (`package.json`, `tsconfig.json`, `src/`).
- Modified files: `apps/api/src/scripts/generate-spec.ts` (full rewrite), `apps/api/src/app.ts` (swagger-ui registration + version sourcing), `apps/api/package.json` (new `@fastify/swagger-ui` dependency), `packages/db/package.json` (`db:migrate` script target), root `package.json` (new `check-migration-compatibility` script), `.github/workflows/ci.yml` (two new steps), `turbo.json` (new task entry for the contract-test package), `.env.example` (`ENABLE_API_DOCS`), `apps/api/src/__tests__/route-audit.test.ts` (`EXEMPT_PATHS` additions), the four D8 schema/route file pairs (`machine-users`, `projects`, `search`, `notifications`), and — as a direct consequence of the notifications D8.4 fix — `apps/web/src/lib/api/inbox.ts` and `apps/web/src/routes/(app)/notifications/+page.server.ts` (confirmed real consumers of the old bare-array shape).
- **`docker-compose.yml` requires zero changes** (D1/D2) — this is a notable, easy-to-miss point: the temptation to "fix" the Compose file for migration safety is strong, but the fix belongs entirely inside the `db:migrate` npm script's implementation.
- Two small, mechanical `apps/web` changes are required as a consequence of D8.4's confirmed breaking response-shape fix: `apps/web/src/lib/api/inbox.ts` (type update) and `apps/web/src/routes/(app)/notifications/+page.server.ts` (`load()` update) — this is not a new SvelteKit screen or feature, just keeping the one existing web consumer of `GET /api/v1/notifications/inbox` in sync with its corrected API contract. No other `apps/web` changes are in scope (API-only surface otherwise — see Product Surface Contract).

### Testing Standards Summary

- Vitest across all packages, matching every other story in this codebase.
- The new `packages/api-contract-tests` package needs a real migrated test database (same `DATABASE_URL`/CI Postgres-service convention as `apps/api`'s own integration tests) — it is not a pure-unit-test package.
- `route-audit.test.ts` must pass with the two new routes (`/api/v1/openapi.json`, `/api/v1/docs`) correctly classified as sealed-vault-exempt (AC-16).
- `pnpm jscpd` must pass — do not duplicate `findDestructiveStatements()` between the runtime wrapper (D2) and the CI script (D3); export it once from `packages/db` and import it in both places.

### Previous Story Intelligence

- Stories 9.1 and 9.2 are both still `ready-for-dev` (not `done`) as of this story's creation, and this story has **no hard sequencing dependency** on either — it touches an entirely disjoint set of files (no shared schema, no shared route module). It can be implemented in any order relative to 9.1/9.2.
- Story 9.2's D2 (a `/admin/*` URL-prefix authorization-semantics collision, resolved by physically separating `modules/admin/` from a new `modules/platform-admin/`) is the precedent this story's D5 followed when choosing to gate `/api/v1/docs`/`/api/v1/openapi.json` more strictly than epics.md's literal always-on text — both decisions prioritize this project's own established security posture over a literal epics.md reading when the two conflict.
- Story 9.2's D1 established the pattern of explicitly stating "as of this story's creation, X does not exist yet" rather than assuming epics.md's aspirational description is already true — this story applies the identical discipline to `generate-spec.ts`, `@fastify/swagger-ui`, and the `migrate` destructive-guard, all independently verified absent before writing any AC around them.

### Git Intelligence (Recent Commits)

- No commit yet touches `apps/api/src/scripts/generate-spec.ts` beyond its original hardcoded-stub form, `packages/db/src/lib/migration-safety.ts`, or `packages/api-contract-tests/` — greenfield within an otherwise mature codebase.
- `apps/api/src/modules/credentials/schema.ts` and `apps/api/src/lib/pagination.ts` are the two files most worth reading before starting Task 6 — they are the correct, already-shipped reference implementation every D8 fix should match in shape.
- `apps/api/src/__tests__/route-audit.test.ts` is the existing convention for route-classification regression tests — read it before adding the new `/api/v1/openapi.json`/`/api/v1/docs` exemption entries (AC-16) to match its established style rather than inventing a parallel mechanism.

### Cross-References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 9.3: In-Place Version Upgrades & API Parity Verification] (lines ~2067-2091) — literal AC text this story's ACs are derived from.
- [Source: _bmad-output/planning-artifacts/epics.md#Epic 9: Platform Operations, API & Self-Hosting] (preamble, lines ~1989-2001) — FR coverage; AC-E9a (parity verification mechanism, blocker) and AC-E9b (upgrade scope, blocker) are the two blocker constraints this story exists to satisfy.
- [Source: _bmad-output/planning-artifacts/prd.md#Platform & Integration] (FR47, FR48, FR50, FR97 — lines ~936-949).
- [Source: _bmad-output/planning-artifacts/architecture.md] — OpenAPI type generation pipeline and `createMockApp` intent (lines ~356-366), directory structure (`apps/api/src/scripts/generate-spec.ts`, `plugins/swagger.ts`, lines ~966-973), pagination convention (`page`-based for all others, cursor-based for audit — line ~844), single-instance/startup-guard constraint (lines ~292-298), self-hosted upgrade notification section (lines ~417-419).
- [Source: _bmad-output/implementation-artifacts/9-1-encrypted-backup-and-restore.md] and [9-2-system-settings-multi-org-and-resource-monitoring.md] — sibling Epic 9 stories; D1/D2 precedent for stating "this primitive does not exist yet" explicitly; D2 (9.2) precedent for security-conscious divergence from epics.md's literal text.
- [Source: _bmad-output/implementation-artifacts/product-surface-contract.md] — Product Surface Contract rules (G1-G4) applied above.
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]
- Direct source verification performed for this story (file:approximate-line, current codebase state as of 2026-07-06): `apps/api/src/scripts/generate-spec.ts` (8-path stub), `apps/api/src/app.ts:142` (`@fastify/swagger` already registered), `apps/api/package.json:17-38` (no `@fastify/swagger-ui`), `packages/db/package.json:28` (`db:migrate` = raw `drizzle-kit migrate`), `packages/db/drizzle.config.ts`, `packages/db/src/migrations/*.sql` (35 files, none destructive), `packages/db/src/index.ts:9-17` (lazy DB client construction), `docker-compose.yml` (existing `migrate` one-shot service), `apps/api/src/config/env.ts` (`DATABASE_URL`/`CORS_ALLOWED_ORIGINS` required, no defaults), `apps/api/src/lib/pagination.ts` and `apps/api/src/lib/api-contracts.ts` (existing pagination helpers), `apps/api/src/modules/credentials/schema.ts` (compliant precedent), `apps/api/src/modules/machine-users/schema.ts` + `routes.ts` (D8.1 bug), `apps/api/src/modules/projects/schema.ts` + `routes.ts` (D8.2 gap), `apps/api/src/modules/search/schema.ts` (D8.3 gap), `apps/api/src/modules/notifications/schema.ts` (D8.4 gap), `apps/api/src/modules/audit/routes.ts` (no list/search endpoint exists yet — Story 8.2 not yet implemented), `.github/workflows/ci.yml` (existing freshness-check step, no `DATABASE_URL` on Typecheck/generate-spec steps), `turbo.json` (`generate-spec`/`typecheck` task dependency).

### Open Questions (for Epic 9 sprint planning / retrospective — not blockers to `ready-for-dev`)

1. Story 9.5 (Operational Runbook, still `backlog`) must fill in `docs/runbook.md § Upgrades` with the actual offline migration procedure this story's `--allow-destructive` error message references (AC-20) — flag explicitly when 9.5 is written; until then, the reference is a forward-pointer to a section that doesn't exist yet, which is acceptable per this story's own scope boundary but should not be forgotten.
2. Story 9.5 should also document the `ENABLE_API_DOCS` production trade-off (D5) as part of its deployment-hardening guidance, so operators who want docs exposed behind their own reverse-proxy auth know the flag exists and its security rationale.
3. No story currently scopes a web-UI surface for triggering/observing an in-place upgrade or browsing API docs from within the app shell (Product Surface Contract gap — same pattern as Stories 9.1/9.2; must be raised at Epic 9 retro per G2).
4. When Story 8.2 (Audit Log Search, Export & External Forwarding — still `backlog`) ships its cursor-paginated audit search/list endpoint, its response shape (`{ items, nextCursor, hasMore }` or similar, per `architecture.md`'s "cursor-based pagination for audit log" note) must be added to this story's D7 exemption allowlist in `packages/api-contract-tests` — flag explicitly when 8.2 is written, so its contract test doesn't fail against a rule designed for page-based endpoints.
5. Whether `GET /api/v1/search` needs a genuine offset-based pagination implementation added to its underlying query (not just response-schema fields) depends on how `SearchQuerySchema`/the search service currently handles large result sets — verify at implementation time rather than assuming the query layer already supports an efficient offset (PostgreSQL `tsvector` ranking + `LIMIT`/`OFFSET` is the expected approach, consistent with `credentials`'s existing pattern, but confirm before assuming zero query-layer work is needed).

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

- Ultimate context engine analysis completed — comprehensive developer guide for Story 9.3 covering: reconciling epics.md's literal "API container runs migrations" wording with the already-shipped one-shot Compose `migrate` service (D1); adding a destructive-migration runtime guard where none exists today, since `db:migrate` is currently raw unguarded `drizzle-kit migrate` (D2); a full-history CI compatibility gate verified to pass retroactively against all 35 existing migrations with zero changes required (D3); replacing a hand-maintained 8-route OpenAPI stub with real Fastify/`@fastify/swagger` introspection that requires no live database connection, verified via the lazy-connection behavior of the existing `postgres`/`packages/db` client (D4); adding Swagger UI and a live spec route, deliberately gated outside production beyond epics.md's literal always-on text for the same security-conscious reasons Story 9.2's D2 established (D5); a new contract-test package interpreting "against a running instance" as `app.inject()` against a migrated test database, consistent with every existing integration test's own convention (D6); an independent FR97 pagination-field verification rule that does not rely on each route's own (possibly incomplete) declared schema — motivated by a concretely verified live bug where a machine-users list handler computes complete pagination metadata that its response schema silently strips from the wire (D7); four concretely verified, not hypothetical, FR97 gaps and their fixes, each cross-referenced to an already-compliant sibling implementation to copy rather than reinvent (D8); and an explicit, architecture-grounded scope boundary against building any zero-downtime/rolling-upgrade mechanism, since the codebase's own single-instance startup guard would reject it (D9).

### File List
