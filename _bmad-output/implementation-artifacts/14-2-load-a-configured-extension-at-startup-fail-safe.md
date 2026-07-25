# Story 14.2: Load a Configured Extension at Startup, Fail-Safe

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a self-hosted administrator,
I want the vault to load my configured extension package at startup without risking an outage if it's misconfigured,
so that a bad extension config never takes down my vault.

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `api` |
| **Evaluator-visible** | yes — `GET /api/v1/admin/extensions/status` is a real, callable endpoint; `GET /health`'s new `extensions_status` field is visible to anyone (unauthenticated) who checks the health endpoint |
| **Linked UI story** (if API-only) | `TBD` — **blocking note:** no story in the current sprint backlog builds the `(app)/admin/extensions/` status page that architecture.md's project structure lists as the consumer of this endpoint. No epic-14 story (14.0-14.4) covers it, and no other tracked epic does either. This story does not silently defer it — flag it for a follow-up story (either appended to Epic 14 or scheduled as an Epic 12-style admin-UI story) before Epic 14 is allowed to move to `done` per G2. Until that UI story exists, an OrgAdmin who wants to see "is my extension loaded" must call the API directly (`curl`/`httpie`) or read `GET /health`. |
| **Honest placeholder AC** (if UI deferred) | AC-4 below — `GET /api/v1/admin/extensions/status` returning `null` when no extension is loaded is the honest, already-correct empty state a future UI page would render as "No extension configured" (not a fabricated success state). |
| **Persona journey** | See below |

### Persona journey stub

**Riley-admin (OrgAdmin, self-hosted deployment), API-only journey — no UI in this story:**
1. Riley sets `VAULT_EXTENSIONS_PACKAGE` in their `.env` / container env and restarts the API.
2. Boot succeeds either way (loaded or failed) — Riley never experiences a crashed vault from a bad extension config.
3. Riley checks `GET /health` (no auth required, e.g. from a monitoring dashboard or `curl`) and sees `extensions_status: "loaded" | "not_configured" | "load_failed"`.
4. If Riley wants extension details (name, version, capabilities), Riley (or their monitoring script) calls `GET /api/v1/admin/extensions/status` with an OrgAdmin session and gets the manifest JSON or `null`.
5. If load failed, Riley checks the API's structured logs for the fatal-equivalent log line (fixed-enum `reason`, never a raw stack trace) and the org's audit log for `extension.load_failed`, then fixes their config and restarts.
6. Expected UI outcome: **none yet** — this journey is entirely API/ops-tooling driven until the linked UI story ships. This is the honest state, not a gap being hidden.

## Acceptance Criteria

1. **No extension configured — zero behavior change.**
   **Given** `VAULT_EXTENSIONS_PACKAGE` is unset (or empty string),
   **when** the API starts,
   **then** zero extension code loads (no `import()` call is attempted), `GET /health` includes `extensions_status: "not_configured"`, `GET /api/v1/admin/extensions/status` (OrgAdmin) returns `null`, and every existing route/behavior is byte-for-byte identical to a build with no extension system at all — this is the tested, supported default for self-hosted Docker deployments.

2. **Valid extension loads successfully and is audited.**
   **Given** `VAULT_EXTENSIONS_PACKAGE` is set to a valid, resolvable package name whose default export registers a well-formed manifest (valid reverse-DNS `name`, `apiVersion` compatible with `packages/extension-api`'s `EXTENSION_API_VERSION`) via a stub `hooksFactory` returning a minimal no-op `NotificationChannel` hook,
   **when** the API starts,
   **then** `apps/api/src/extensions/loader.ts`:
   - dynamically imports the package via native ESM `import()` (no bundler/loader plugin),
   - calls `registerExtension(manifest, hooksFactory)` from `@project-vault/extension-api`, which validates the manifest (name pattern + capability negotiation, per Story 14.1) **before** `hooksFactory()` is ever invoked,
   - on success, stores the returned hooks in the loader's module-level state (generic hook-type dispatch — e.g. keyed by hook kind — **not** auth-strategy wiring; `registerAuthStrategy()`/`authStrategies` integration is Story 14.3's scope and must not be built here),
   - writes an `AuditEvent.EXTENSION_LOADED` entry with `manifest.name`, `manifest.apiVersion`, `manifest.capabilities` in its payload,
   - and `GET /api/v1/admin/extensions/status` (OrgAdmin only) returns `{ name, apiVersion, capabilities, loadedAt }` for the loaded manifest, and `GET /health` includes `extensions_status: "loaded"`.

   **And** this AC is testable with the minimal stub hook described above — it must not require Story 14.3's auth-strategy dispatch machinery to exist.

3. **Extension fails to load — API still starts, fails safe.**
   **Given** `VAULT_EXTENSIONS_PACKAGE` is set to a package that (a) fails to import (module not found / throws on import), (b) fails manifest validation (bad `name` per the reverse-DNS regex), or (c) fails capability negotiation (`apiVersion` incompatible with core's `EXTENSION_API_VERSION`),
   **when** the API starts,
   **then**:
   - the failure is caught at the loader call site (never propagates to crash `main()`),
   - it is logged at `pino.fatal`-equivalent severity with a **fixed-enum `reason`** — exactly one of `'import_error' | 'manifest_invalid' | 'capability_mismatch'` — **never** the raw exception message or stack trace (both because the exception could leak internal paths/config content, and to match this codebase's "secret values must not appear in logs/stack traces" pattern),
   - an `AuditEvent.EXTENSION_LOAD_FAILED` entry is written with that same fixed-enum `reason` in its payload (also never the raw message/stack),
   - `GET /health` reports `extensions_status: "load_failed"`,
   - `GET /api/v1/admin/extensions/status` returns `null` (a failed load is not a loaded extension),
   - and **the API process still starts and serves all core functionality identically to AC-1** — every existing route, local auth, credentials, rotation, etc. work exactly as if no extension were configured.

   **Edge case — differentiate the three failure reasons with dedicated tests:**
   - 3a. `import_error`: `VAULT_EXTENSIONS_PACKAGE` names a package that does not resolve (e.g. not installed) → `import()` rejects → caught, logged/audited with `reason: 'import_error'`.
   - 3b. `manifest_invalid`: the package resolves and its `hooksFactory`-providing call reaches `registerExtension()`, but the manifest's `name` fails the reverse-DNS regex → `registerExtension()` throws `ExtensionRegistrationError` with `reason: 'invalid-name'` (Story 14.1) → loader maps this to its own `reason: 'manifest_invalid'` for the audit/log entry (do not leak the extension-api package's internal `reason` string verbatim if it differs from this story's fixed enum — translate explicitly).
   - 3c. `capability_mismatch`: manifest `apiVersion` incompatible with core's `EXTENSION_API_VERSION` → `registerExtension()` throws `ExtensionRegistrationError` with `reason: 'incompatible-version'` → loader maps to `reason: 'capability_mismatch'`.
   - 3d. **Crash inside `hooksFactory()` itself** (extension code throws during hook construction, after negotiation passed): this is not one of `import_error`/`manifest_invalid`/`capability_mismatch` per epics.md's literal enum, but per architecture.md's fail-safe philosophy ("a self-hosted admin's extension misconfiguration must not take down their vault") it **must** be caught by the same try/catch at the loader call site and treated as a load failure, not an unhandled rejection that crashes boot. Use `reason: 'import_error'` as the closest fit **unless/until** a fourth enum value is explicitly added — flag this as an open question resolved with a judgment call below (see Dev Notes) rather than leaving it unhandled.
   - 3e. **Timeout / hang inside `hooksFactory()` or the dynamic `import()` itself:** neither epics.md nor architecture.md specifies a timeout for extension loading. A judgment call is required — see Dev Notes "Open Questions / Judgment Calls" below for the resolution this story adopts (a bounded timeout wrapping both the `import()` and the `hooksFactory()` call, treated as `import_error` on expiry) so a hanging extension package cannot hang API boot indefinitely.

4. **Status endpoint — no extension loaded returns null.**
   **Given** no extension is loaded (either `VAULT_EXTENSIONS_PACKAGE` unset, or it was set but failed to load per AC-3),
   **when** `GET /api/v1/admin/extensions/status` is called by an authenticated OrgAdmin,
   **then** it returns `200` with body `null` (not `404`, not an empty object — a real "nothing loaded" value the future UI page renders as an explicit empty state, not a fabricated success state, per Product Surface Contract G3).

5. **Status endpoint — non-admin is forbidden.**
   **Given** an authenticated user whose org role is `owner`, `member`, or `viewer` (not `admin`),
   **when** they call `GET /api/v1/admin/extensions/status`,
   **then** the response is `403` — regardless of whether an extension is loaded. Cover this with a dedicated test per non-admin role (or at minimum `member` and `viewer`; `owner` is explicitly **not** treated as equivalent to OrgAdmin for this route — confirm this reading against `secure-route.ts`'s `allowedRoles` semantics, see Dev Notes).

   **And** an unauthenticated caller receives `401` (standard `SecureRoute` default — cover with a test for completeness even though epics.md doesn't spell this sub-case out explicitly).

6. **`GET /health` never requires auth and never blocks on extension state.**
   **Given** any of the three `extensions_status` values (`not_configured` / `loaded` / `load_failed`),
   **when** `GET /health` is called (no auth header),
   **then** it always returns `200` (extension state is informational, never a readiness/liveness failure — `GET /health` remains a liveness check, not readiness; do not conflate with `GET /ready`'s existing 503 semantics for DB/vault-seal state) with `extensions_status` present alongside the existing `status`/`version` fields.

## Tasks / Subtasks

- [x] Task 1: Add `VAULT_EXTENSIONS_PACKAGE` to env config (AC: 1, 2, 3)
  - [x] Write a failing test in `apps/api/src/config/env.test.ts` asserting `env.VAULT_EXTENSIONS_PACKAGE` is `undefined` when unset and equals the provided string when set (follow the existing `SMTP_USER`/`SMTP_PASS` `z.preprocess((v) => (v === '' ? undefined : v), z.string().optional())` pattern so an empty-string env var behaves identically to unset)
  - [x] Add the Zod field to `apps/api/src/config/env.ts`'s schema; confirm test passes
  - [x] Add `VAULT_EXTENSIONS_PACKAGE=` (commented, blank) to `apps/api/.env.example` with a one-line comment explaining it's optional and self-hosted Docker never needs it
- [x] Task 2: Define the loader's internal failure-reason enum and module-level extension state (AC: 2, 3)
  - [x] Write failing unit tests for `apps/api/src/extensions/loader.ts` (new file, new co-located `loader.test.ts`) covering: unset env → no-op; valid package → hooks stored + manifest retrievable; each of the three failure reasons (3a/3b/3c) → no throw escapes, state reflects `load_failed`, manifest retrieval returns `null`
  - [x] Implement `loader.ts`: `loadExtension(packageName: string | undefined): Promise<void>` (or similar) that:
    - no-ops if `packageName` is falsy
    - wraps the dynamic `import()` + `registerExtension()` call chain in try/catch, mapping `ExtensionRegistrationError.reason` (`'invalid-name'` → `'manifest_invalid'`, `'incompatible-version'` → `'capability_mismatch'`) and any other thrown/rejected error (including a `hooksFactory()` crash, per AC-3d) to `'import_error'`
    - applies a bounded timeout around the `import()` + registration chain (see Dev Notes judgment call) — on timeout, treat identically to `'import_error'`; attach a no-op `.catch()` to the losing (still-running) promise so a late rejection after timeout cannot produce an unhandled rejection, and ignore a late resolution (state is already finalized) — test both cases explicitly
    - stores the outcome in module-level state: `{ status: 'not_configured' | 'loaded' | 'load_failed', manifest?: {...}, loadedAt?: string, hooks?: Record<string, unknown> }`
    - guards against double-invocation: if state is already `'loaded'` or `'load_failed'` when called again, no-op + warn-log rather than re-running `hooksFactory()` or overwriting state — test this
  - [x] Export `getExtensionStatus()` (returns the module-level state) and `getExtensionsHealthField()` (returns just the `extensions_status` string for `GET /health`) — small, focused accessors so `routes/health.ts` and the new status route don't reach into loader internals directly
  - [x] Never invoke `hooksFactory` before both the reverse-DNS name check and the semver capability check pass (this is `registerExtension()`'s own guarantee from Story 14.1 — the loader must not add an eager pre-call of its own around it)
- [x] Task 3: Wire audit writes for load success/failure (AC: 2, 3)
  - [x] Resolve the "boot-time event has no org context" gap per the Dev Notes judgment call below **before** writing code — this determines the audit-write call shape
  - [x] Write failing tests asserting an `AuditEvent.EXTENSION_LOADED` / `AuditEvent.EXTENSION_LOAD_FAILED` row is written with the correct payload shape and fixed-enum `reason` (failure case) — use the same DB-integration test harness pattern as `apps/api/src/__tests__/*.test.ts` (`withTestOrg`), adapted for a boot-time (non-request) call site
  - [x] Write a failing test asserting that if the per-org audit write throws for one org during the fanout, the loop continues for remaining orgs (log-and-continue, not abort) and `loadExtension()`'s own resolution/state is unaffected by the audit-write failure
  - [x] Implement the audit write per the resolved judgment call
  - [x] Add `EXTENSION_LOADED: 'extension.loaded'` and `EXTENSION_LOAD_FAILED: 'extension.load_failed'` to `packages/shared/src/constants/audit-events.ts`'s `AuditEvent` object (lowercase dot-notation, matching the modern half of the registry — see architecture.md) — write/update `packages/shared/src/constants/audit-events.test.ts` first if it asserts the full key set
- [x] Task 4: Add operational (pino) fatal-equivalent logging on failure (AC: 3)
  - [x] Write a failing test asserting the loader logs via the structured logger at `fatal`-equivalent severity with `{ eventType: <appropriate OperationalEvent or new constant>, reason }` and explicitly does **not** include `err`/`stack`/raw exception message fields
  - [x] Implement using this codebase's existing logging helpers (`operationalLog` / `serializeLogError` pattern in `apps/api/src/lib/logger.ts` — but do **not** use `serializeLogError` as-is here since it includes `message`/`stack`; either write a redacted variant or log only the fixed-enum reason, following the "secret values/stack traces must not appear in logs" precedent already established for other security-sensitive log paths)
- [x] Task 5: Extend `GET /health` with `extensions_status` (AC: 1, 2, 3, 6)
  - [x] Write failing tests in `apps/api/src/routes/health.test.ts` for all three `extensions_status` values, and assert `GET /health` still returns `200` unauthenticated in every case
  - [x] Update the `ReadyResponseSchema`-adjacent schema for `/health` (currently untyped `{status, version}` — add a schema if none exists, or extend inline) to include `extensions_status: z.enum(['not_configured', 'loaded', 'load_failed'])`
  - [x] Update `healthRoutes`'s `/health` handler (not `/ready` — confirm this placement against AC-1/2/3's literal "GET /health reports..." language; do not conflate with the separate `/ready` endpoint's DB/vault-seal readiness semantics) to call `getExtensionsHealthField()` and include it in the response
- [x] Task 6: Add `GET /api/v1/admin/extensions/status` route (AC: 2, 4, 5)
  - [x] Write failing integration tests (new file `apps/api/src/extensions/status-routes.test.ts` or co-located with the route file) covering: OrgAdmin + loaded → manifest JSON; OrgAdmin + not loaded/failed → `null`; non-admin roles (member, viewer) → `403`; unauthenticated → `401`
  - [x] Implement `apps/api/src/extensions/status-routes.ts` using `secureRoute()` (see `modules/admin/routes.ts` for the pattern) with `security: { allowedRoles: ['admin'], requireMfa: true, writeAuditEvent: false }` (a read-only status check does not itself need its own audit event — confirm this against the "OrgAdmin only" language in epics.md, which does not require auditing the *read*, only the *load*)
  - [x] Register the route in `apps/api/src/app.ts` — mount at the `ADMIN_PREFIX` alongside `adminRoutes`/`backupRoutes`/etc. (see existing registration block, line ~270), since this is functionally an admin-status read even though the implementation file lives under `extensions/` rather than `modules/admin/` (judgment call — see Dev Notes)
- [x] Task 7: Invoke the loader at boot, in the correct startup order (AC: 1, 2, 3)
  - [x] Write/extend a boot-sequence test (integration-style, mocking I/O similar to `generate-spec.ts`'s dry-run pattern, or a dedicated `main`-adjacent test) asserting the loader runs and does not block/crash `createApp()`/`main()` startup in either the success or failure case
  - [x] Call `loadExtension(env.VAULT_EXTENSIONS_PACKAGE)` from the correct place in `apps/api/src/app.ts`'s `createApp()` (after core routes are registered, so `authStrategies`'s local-first invariant from architecture.md is trivially satisfied even though this story does not yet wire `registerAuthStrategy()` — that's Story 14.3) — **not** from `main.ts`, to keep `createApp()` a complete, testable unit the way `health.test.ts` already exercises it via `createApp({ logger: false })`
  - [x] Confirm via a test that a thrown/rejected `loadExtension()` call is impossible to escape uncaught (the function itself never rejects — it always resolves, storing failure state internally) so a bug in this story's own code cannot regress AC-3's "still starts" guarantee
- [x] Task 8: Route-audit and CI conformance (AC: 4, 5)
  - [x] Run `apps/api/src/__tests__/route-audit.test.ts` — confirm the new `GET /api/v1/admin/extensions/status` route is exempted correctly or (expected) passes because it uses `secureRoute()` and appears in `secureRoutes: Set<string>`
  - [x] If `route-exemptions.ts` needs a new entry for `/health`'s response-shape change, confirm none is needed (it's an additive field, not a new route)
- [x] Task 9: Full regression pass
  - [x] `pnpm turbo typecheck/lint/test --filter=@project-vault/api` (and `--filter=@project-vault/shared` for the audit-events change)
  - [x] `make ci`-equivalent local run if time permits, or at minimum the story's own new/changed test files plus `apps/api/src/__tests__/route-audit.test.ts` and `apps/api/src/routes/health.test.ts`
  - [x] Confirm this repo's 80/80/80/80 coverage bar is met for new files (`loader.ts`, `status-routes.ts`)

## Dev Notes

### Scope boundaries — what this story is NOT

- **No `registerAuthStrategy()` / `authStrategies` wiring.** That is Story 14.3's entire scope. This story's loader stores whatever hooks the stub factory returns in generic, hook-kind-keyed module state — it does not special-case `AuthStrategy` or append anything to an `authStrategies` list (that list/dispatcher does not exist until 14.3 creates `modules/auth/strategies.ts`'s `registerAuthStrategy()`).
- **No admin UI page.** `(app)/admin/extensions/` does not exist in this repo yet (confirmed: `apps/web/src/routes/(app)/` currently has no `admin/` directory at all — the entire admin UI section referenced in architecture.md's project-structure tree is aspirational, not yet built for *any* admin feature, not just extensions). Do not build it in this story. See Product Surface Contract above for the tracked gap.
- **No community-extension install pathway, no sandboxing.** `loader.ts` resolves `VAULT_EXTENSIONS_PACKAGE` by exact package identity only — this is the founder's own private, trusted package. [Source: architecture.md L548] This is a deliberate trade-off, not an oversight: sandboxing (VM isolation, worker-thread process boundary) was considered and rejected for this phase because it adds significant complexity for a threat model (malicious *first-party* package) that doesn't exist yet — community extensions are explicitly out of scope until a later phase, at which point sandboxing becomes a hard requirement, not optional hardening. Do not add partial sandboxing in this story; it would be dead complexity today and the wrong shape once real sandboxing is needed.
- **Manifest validation does NOT gate module-level code execution.** Native ESM `import()` executes the target module's top-level code (including any side effects at module scope — network calls, file I/O, timers) *before* `registerExtension()` gets a chance to validate the manifest or negotiate capabilities. AC-3's fail-safe guarantee is about the *vault continuing to run* if the manifest is bad or `hooksFactory()` misbehaves — it is not a guarantee that untrusted code never executes. This is consistent with the "own private trusted package" threat model above and requires no code change, but must not be misdocumented as "nothing runs until validation passes" anywhere in code comments or the API response — say "loaded" only after full validation + `hooksFactory()` success, but don't imply import-time execution is gated.
- **No `capabilities[]` enforcement.** `capabilities` is informational/audit-only in this phase — record it in the `EXTENSION_LOADED` payload, but do not gate hook registration on it. [Source: architecture.md L476, L835]

### Open Questions / Judgment Calls (resolved here so implementation is unblocked)

Per AGENTS.md: "If requirements conflict, pause to reconcile the intended behavior instead of layering compatibility shims over an unclear contract." Two real gaps exist between epics.md/architecture.md and the actual codebase; both are resolved below with a concrete default rather than left ambiguous.

1. **Audit write has no natural org context at boot.** `audit_log_entries` (`packages/db/src/schema/audit-log-entries.ts`) uses `orgScoped()`, i.e. `org_id` is `NOT NULL` and the table is RLS-scoped per org. Extension loading is a single, global, boot-time event — there is no request, no `authContext`, no single "the" org it belongs to. Neither epics.md nor architecture.md's "writes an `AuditEvent.EXTENSION_LOADED` entry" language addresses this. `platform_audit_events` (the other candidate table) requires a non-null `operatorId` (a human platform operator) and is designed for platform-operator-initiated actions, not automated boot events — also not a clean fit.
   **Resolution adopted by this story:** at boot, after the loader resolves (success or failure), enumerate all existing organizations and write one `writeSystemAuditRow(tx, { orgId, eventType, payload })` (`actorType: 'system'`, `actorTokenId: null` — see `apps/api/src/lib/system-audit-row.ts`) per org, inside `withOrg(orgId, ...)`, mirroring the existing precedent of `check-failed-auth-threshold.ts`/`org-health-snapshot.ts` iterating all orgs for boot/cron-scoped system events that lack a single natural org. **This is a genuine judgment call, not a directly-sourced requirement** — flag it explicitly in the PR description for maintainer confirmation. If this doesn't hold up in review, the fallback is: skip the DB audit-row write entirely and rely solely on the structured `pino` fatal-equivalent log (Task 4) as the load-failure record of truth, since that requirement (AC-3) is unambiguous and does not depend on org context. Do not block the rest of the story on resolving this — implement the org-fanout version, and if it's rejected in review, deleting it is a small, isolated change (Task 3 only).
2. **`hooksFactory()` crash and load timeout are not in epics.md's literal 3-value enum.** AC-3's `reason` enum (`import_error | manifest_invalid | capability_mismatch`) has no slot for "the factory itself threw after negotiation passed" or "loading hung." **Resolution:** both map to `'import_error'` (closest semantic fit — "the extension failed to come up") rather than inventing a 4th enum value not sanctioned by epics.md's literal AC text. A bounded timeout (recommend 5000ms, matching the existing 5s SMTP-test timeout precedent in `modules/admin/routes.ts`'s `testEmailDelivery()`) wraps the `import()` + `hooksFactory()` chain via `Promise.race`, same pattern as that existing precedent.
3. **`Promise.race` timeout does not cancel the underlying `import()`/`hooksFactory()` call — it only stops waiting for it.** Native ESM `import()` and an arbitrary synchronous-or-async `hooksFactory()` have no cancellation token; after the timeout "wins" the race and the loader records `load_failed`, the original promise chain is still running in the background and may resolve or reject later, potentially after `loadExtension()` has already returned. **Resolution:** attach a no-op `.catch()` to the losing promise (so an eventual late rejection doesn't produce an `unhandledRejection` that crashes the process — the exact opposite of this story's fail-safe goal) and do not act on a late resolution (module state has already been finalized as `load_failed`; a late success is discarded, not retroactively applied). Add a unit test asserting a late-resolving/late-rejecting `hooksFactory` after timeout does not throw an unhandled rejection and does not mutate loader state after `load_failed` is recorded.
4. **Audit fanout (judgment call #1) must not itself be allowed to crash boot.** Iterating "all existing organizations" to write one audit row per org means N sequential/parallel DB calls at startup; a single org's write failing (e.g. transient DB blip, a mid-migration org) must not abort the loop or propagate out of `loadExtension()` — wrap each per-org `writeSystemAuditRow` call individually, log-and-continue on failure (using the same fatal-equivalent structured logging as Task 4, with a distinct sub-reason so it's distinguishable from an actual extension load failure), and let the overall extension load outcome (`loaded`/`load_failed`) stand independent of whether every audit row succeeded. Add a test: audit write throws for one org → loader still resolves, `getExtensionStatus()` still reflects the real load outcome, no unhandled rejection.
5. **Idempotency / double-invocation guard.** Nothing currently prevents `loadExtension()` from being called twice (e.g. a future refactor accidentally calls it from both `createApp()` and a test helper, or hot-module-reload in dev). A second call should not re-run `hooksFactory()` a second time (which could double-register side effects or double-write audit rows) or overwrite already-`loaded` state with a redundant load. **Resolution:** guard on module-level state — if `getExtensionStatus().status !== 'not_configured'` when `loadExtension()` is invoked again, no-op and log a warning rather than re-executing. Add a test for double-invocation.

### Architecture compliance (must follow exactly)

- **Loader location and responsibility:** `apps/api/src/extensions/loader.ts` — new directory, distinct from `apps/api/src/plugins/` (rotation plugins are a different thing entirely; do not confuse the two `plugins`/`extensions` concepts). [Source: architecture.md L1120-1121, "extensions/ — Phase 2 — general-purpose extension loading, distinct from plugins/ (rotation plugins)"]
- **`hooksFactory` must remain lazy** — this story's loader must not call `hooksFactory()` itself before `registerExtension()`'s own gate passes; `registerExtension()` (from Story 14.1's `packages/extension-api`) already enforces this, the loader must not bypass it or add its own eager pre-invocation. [Source: architecture.md L475, 14-1 story Dev Notes "Ordering discipline is the core correctness property"]
- **Env var naming:** `VAULT_EXTENSIONS_PACKAGE` — must keep the existing `VAULT_*` prefix convention, never a bare `EXTENSIONS_PACKAGE`. [Source: architecture.md L712]
- **Failure reason enum is fixed and exhaustive per epics.md's literal AC text:** `'import_error' | 'manifest_invalid' | 'capability_mismatch'` — never the raw exception message or stack trace, matching the existing "secret values must not appear in logs/stack traces" security pattern. [Source: architecture.md L895, epics.md Story 14.2 AC]
- **Boot sequence ordering (restated from architecture.md for implementation-time visibility):** (1) built-in local auth strategy registers [not this story — already exists via `modules/auth/routes.ts`/module load], (2) `VAULT_EXTENSIONS_PACKAGE` resolved if set, (3) manifest validated + `semver.satisfies()` capability negotiation checked — `hooksFactory` **not yet called**, so zero extension code has executed at this point, (4) on success, `hooksFactory()` invoked and hooks stored; `AuditEvent.EXTENSION_LOADED` writes; on failure at any point in (2)-(3), `hooksFactory` never called, core continues, `AuditEvent.EXTENSION_LOAD_FAILED` writes with fixed-enum reason — never a partial registration. [Source: architecture.md L967]
- **`GET /health` vs `GET /ready` — do not conflate.** The *actual, current* `apps/api/src/routes/health.ts` (read in full during story creation, not assumed from architecture.md) has `/health` as a trivial unauthenticated liveness check (`{status: 'ok', version}`, always 200) and a separate, richer `/ready` with `503` semantics for DB/vault-seal state. architecture.md's prose ("GET /health readiness payload (FR81)") uses "readiness" loosely and does **not** match this file-level split precisely. epics.md's literal AC text says `GET /health reports...` for extension state (not `/ready`) — follow epics.md's literal route name. `extensions_status` must **never** cause `/health` to return non-200; it is informational only, consistent with `/health`'s existing unconditional-200 contract. Do not add extension-load-failure to `/ready`'s existing 503 triggers (DB unreachable, vault sealed/uninitialized) — those are a different, unrelated readiness concern.
- **RBAC role mapping:** epics.md/architecture.md's "OrgAdmin" maps 1:1 to this codebase's literal `'admin'` org role string (see `apps/api/src/plugins/require-org-role.ts`'s `OrgRole = 'owner' | 'admin' | 'member' | 'viewer'`). "OrgAdmin only" means `allowedRoles: ['admin']` — **not** `['owner', 'admin']`. This is a judgment call resolved by literal string matching (`OrgAdmin` ≈ `admin`) since no other Phase 2 story or architecture section defines the mapping explicitly; if this proves wrong in review, it's a one-line fix to the route's `allowedRoles` array.
- **`SecureRoute` usage:** follow `apps/api/src/modules/admin/routes.ts`'s exact pattern (`secureRoute(fastify, { method, url, schema, security: {...}, handler })`) — do not hand-roll auth checks.
- **No bare Drizzle queries outside `withOrg()`/`withOrgReadScope()`/`withAdminAccess()`** — this ESLint-enforced rule applies to `apps/api/src/**`; the org-fanout audit write (judgment call #1) must use `withOrg(orgId, fn)` per-org, not a bare cross-org query. [Source: architecture.md L994, L1013]

### Project Structure Notes

New files:
- `apps/api/src/extensions/loader.ts` + `apps/api/src/extensions/loader.test.ts`
- `apps/api/src/extensions/status-routes.ts` + `apps/api/src/extensions/status-routes.test.ts` (judgment call: co-located under `extensions/` rather than `modules/admin/routes.ts`, since the route is conceptually part of the extension subsystem, not general system-config admin; `modules/admin/routes.ts`'s own header comment scopes it to "System config only (SMTP, settings, resource usage)" which extensions status doesn't fit)

Modified files:
- `apps/api/src/config/env.ts` (+ `env.test.ts`) — new `VAULT_EXTENSIONS_PACKAGE` optional field
- `apps/api/.env.example` — document the new var
- `apps/api/src/routes/health.ts` (+ `health.test.ts`) — `/health` handler gains `extensions_status`
- `apps/api/src/app.ts` — register `status-routes.ts` at `ADMIN_PREFIX`; call `loadExtension()` inside `createApp()`
- `packages/shared/src/constants/audit-events.ts` (+ `audit-events.test.ts`) — add `EXTENSION_LOADED`/`EXTENSION_LOAD_FAILED`

No `packages/extension-api` changes expected — this story only *consumes* `registerExtension()`/`ExtensionManifest`/`ExtensionRegistrationError` from the already-published package (Story 14.1); if implementation reveals a genuine gap in that package's exported surface, stop and flag it rather than silently patching `packages/extension-api` inside this story (scope discipline, mirroring 14.1's own explicit boundary notes).

No `apps/web` changes — see Product Surface Contract; UI is explicitly out of scope and tracked as a gap, not silently dropped.

### Testing standards summary

- **TDD red-green mandatory** (AGENTS.md): write/extend the failing test first for every task above, confirm it fails for the expected reason, then implement. Do not implement behavior before the test exists.
- Unit tests for `loader.ts` should mock the dynamic `import()` target (e.g. via `vi.mock` of a fixture module path, or an injectable import function for testability — follow whatever pattern keeps `loader.ts` itself free of hardcoded fixture package names; a small `importFn` parameter defaulting to `(spec: string) => import(spec)` is a reasonable, testable seam).
- Integration tests for the status route and boot-time audit write should use `withTestOrg` (`packages/db/test-helpers.ts`), matching `apps/api/src/__tests__/*.test.ts`'s established pattern — but note this story's loader runs at `createApp()` time, not inside a request, so the audit-write test will need to invoke the loader/audit-write function directly against a test org rather than going through `app.inject()`.
- `route-audit.test.ts` must keep passing unmodified — the new status route must register via `secureRoute()` so it appears in `secureRoutes: Set<string>` automatically; do not add a manual exemption.
- Repo coverage bar: 80/80/80/80 (statements/branches/functions/lines), same as `packages/extension-api` achieved in Story 14.1 and the monorepo-wide `@project-vault/tsconfig/vitest.base` default.
- Negative-path coverage is not optional for this story — AC-3's three failure reasons (plus the two judgment-call edge cases 3d/3e) each need their own test, not just a single generic "failure" test, since the fixed-enum `reason` mapping is exactly the kind of branch a single happy-path-biased test suite would silently under-cover.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 14.2: Load a Configured Extension at Startup, Fail-Safe] — literal AC text (5 Given/When/Then blocks), this story's canonical requirement source
- [Source: _bmad-output/planning-artifacts/epics.md#Epic 14: Extension Architecture & Pluggable Authentication] — epic framing, FR113/FR114 mapping, "core never special-cases the extension" invariant, community-extension-out-of-scope note
- [Source: _bmad-output/planning-artifacts/architecture.md#Extension loading (Phase 2 — FR114)] (~L545-550) — `VAULT_EXTENSIONS_PACKAGE` resolution, fail-safe-not-crash rationale, `GET /api/v1/admin/extensions/status` shape
- [Source: _bmad-output/planning-artifacts/architecture.md#Extension API package (Phase 2 — FR113/FR114)] (~L473-477) — lazy-`hooksFactory` gate, `capabilities[]` informational-only decision
- [Source: _bmad-output/planning-artifacts/architecture.md#Extension Lifecycle Audit Trail (Phase 2)] (~L895) — fixed-enum failure reason, audit event names, rationale tying this to the existing secret-redaction-in-logs pattern
- [Source: _bmad-output/planning-artifacts/architecture.md#Extension Registration Ordering (Phase 2)] (~L967) — exact boot sequence restated for implementation
- [Source: _bmad-output/planning-artifacts/architecture.md#Extension & Theme Audit Event Names (Phase 2)] (~L714-717) — `EXTENSION_LOADED`/`EXTENSION_LOAD_FAILED` literal string values
- [Source: _bmad-output/planning-artifacts/architecture.md#Complete Project Directory Structure] (~L1120-1121, L1301) — file placement for `loader.ts`; confirms `(app)/admin/extensions/` UI page is planned-but-not-yet-built
- [Source: _bmad-output/implementation-artifacts/14-1-define-and-publish-the-extension-api-package.md] — prior story in this epic; `registerExtension()`/`ExtensionManifest`/`ExtensionRegistrationError` exact signatures and error `reason` values (`'invalid-name'`, `'incompatible-version'`) this story's loader must map from; confirms no `apps/api` wiring exists yet before this story
- Codebase (read directly during story creation, not inferred from architecture.md alone): `apps/api/src/routes/health.ts`, `apps/api/src/routes/health.test.ts`, `apps/api/src/modules/admin/routes.ts`, `apps/api/src/lib/secure-route.ts`, `apps/api/src/plugins/require-org-role.ts`, `apps/api/src/config/env.ts`, `apps/api/src/lib/system-audit-row.ts`, `apps/api/src/lib/audit-or-fail-closed.ts`, `apps/api/src/modules/platform-audit/write-entry.ts`, `apps/api/src/workers/check-failed-auth-threshold.ts`, `packages/db/src/schema/audit-log-entries.ts`, `packages/db/src/schema/platform-audit-events.ts`, `packages/shared/src/constants/audit-events.ts`, `apps/api/src/app.ts`, `apps/api/src/main.ts`
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]
- TDD process: [Source: AGENTS.md#Development Story Implementation]

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (claude-sonnet-5), via bmad-dev-story

### Debug Log References

- All new/changed test files run RED-first (confirmed failing for the expected reason) before
  each corresponding implementation change, per AGENTS.md TDD process.
- `apps/api/src/extensions/` full suite: 4 files / 26 tests passing (loader.test.ts,
  loader-audit.integration.test.ts, status-routes.test.ts, boot.test.ts).
- `apps/api/src/routes/health.test.ts`: 12/12 passing. `apps/api/src/config/env.test.ts`:
  84/84 passing. `apps/api/src/lib/logger.test.ts`: 8/8 passing.
  `apps/api/src/__tests__/route-audit.test.ts`: 10/10 passing (new status route registers via
  `secureRoute()` and is picked up automatically, no manual exemption needed).
- `packages/shared` full suite: 137/137 passing (new `AuditEvent`/`OperationalEvent` entries).
- `pnpm turbo typecheck lint --filter=@project-vault/api --filter=@project-vault/shared
  --filter=@project-vault/extension-api --filter=@project-vault/db`: 14/14 tasks successful, 0
  lint errors (pre-existing warnings only, unrelated to this story's files).
- Coverage on new files: `apps/api/src/extensions/loader.ts` 98.27%/100%/94.44%/98.07%
  (statements/branches/functions/lines); `apps/api/src/extensions/status-routes.ts` 100% across
  all four metrics — both clear the repo's 80/80/80/80 bar.
- `npx jscpd apps/api/src/extensions packages/shared/src/constants`: 0 clones found.
- `npx tsx scripts/check-env-example.ts`: OK (90 schema keys verified, including
  `VAULT_EXTENSIONS_PACKAGE`).

### Completion Notes List

- **AC-1 (no extension configured, zero behavior change):** `VAULT_EXTENSIONS_PACKAGE` unset (or
  empty string, via the same `z.preprocess` empty-string-as-unset pattern as `SMTP_USER`) makes
  `loadExtension()` no-op before any `import()` call; `GET /health` reports
  `extensions_status: "not_configured"`; `GET /api/v1/admin/extensions/status` returns `null`.
- **AC-2 (valid extension loads and is audited):** `loader.ts` dynamically imports via native
  ESM `import()` (injectable `importFn` seam, default `(spec) => import(spec)`), calls
  `registerExtension()` from `@project-vault/extension-api` (manifest + capability negotiation
  before `hooksFactory()` — enforced by the already-published Story 14.1 package, not
  re-implemented here), stores hooks/manifest in module-level state, writes
  `AuditEvent.EXTENSION_LOADED` per-org, and both `GET /api/v1/admin/extensions/status` and
  `GET /health`'s `extensions_status` reflect `"loaded"`.
- **AC-3 (fail-safe on load failure), sub-cases 3a-3e:** every failure path is caught at the
  loader call site, mapped to the fixed enum, logged at `fatal`-equivalent severity with only
  `{ eventType, reason }` (never the raw message/stack — verified with a dedicated test asserting
  the payload excludes `err`/`stack`/`message` and doesn't leak a sample "secret path" string),
  and audited via `AuditEvent.EXTENSION_LOAD_FAILED`. The API process keeps serving all core
  routes identically to AC-1.
  - 3a `import_error`: `import()` rejects (dedicated test).
  - 3b `manifest_invalid`: `registerExtension()` throws `ExtensionRegistrationError('invalid-name', …)`, mapped explicitly (dedicated test); `hooksFactory` proven never called.
  - 3c `capability_mismatch`: `registerExtension()` throws `ExtensionRegistrationError('incompatible-version', …)`, mapped explicitly (dedicated test).
  - 3d `hooksFactory()` crash after negotiation passed: caught by the same try/catch, mapped to `import_error` per the judgment call (dedicated test, `loadExtension()` proven to still resolve rather than reject/throw).
  - 3e timeout/hang: bounded `Promise.race` (default 5000ms, injectable `timeoutMs` for tests) maps a hang to `import_error`; the losing promise gets a no-op `.catch()` attached immediately (dedicated test proves no `unhandledRejection` fires on a late rejection) and a late resolution is simply never consumed by the race, so it cannot retroactively flip already-finalized `load_failed` state to `loaded` (dedicated test).
- **AC-4 (status endpoint — null when nothing loaded):** `GET /api/v1/admin/extensions/status`
  returns `200` with body `null` (verified distinct from `404`/`{}`) both when unset and after a
  failed load.
- **AC-5 (status endpoint — RBAC):** `allowedRoles: ['admin']` only (not `['owner', 'admin']`) —
  dedicated tests prove `member`, `viewer`, AND `owner` all get `403`, and an unauthenticated
  caller gets `401`.
- **AC-6 (`/health` never blocks/requires auth):** dedicated parametrized test asserts all three
  `extensions_status` values return `200` unauthenticated; `/ready`'s separate 503 semantics
  (DB/vault-seal) are untouched.
- **Judgment calls (Dev Notes) implemented as documented, all flagged here for maintainer
  confirmation per the story's own instruction:**
  1. Boot-time audit has no natural org — implemented as an org-fanout (`fetchAllOrgIds()` +
     `withOrg(orgId, writeSystemAuditRow(...))` per org), with each per-org write individually
     try/caught (log-and-continue via a new `OperationalEvent.EXTENSION_AUDIT_FANOUT_ROW_FAILED`)
     so neither one bad org nor a whole-enumeration failure can affect `loadExtension()`'s own
     resolution or crash boot (dedicated tests for both).
  2. `hooksFactory()` crash and load timeout both map to `'import_error'` (no 4th enum value
     invented).
  3. Timeout-loser-promise handling implemented exactly as specified (no-op `.catch()`, discard
     late resolution).
  4. Audit fanout failure isolation implemented as its own try/catch per org.
  5. Idempotency guard implemented: a second `loadExtension()` call while state is already
     resolved no-ops and warn-logs (new `OperationalEvent.EXTENSION_LOAD_DOUBLE_INVOCATION_IGNORED`),
     verified for both the `loaded` and `load_failed` prior-state cases.
- **RBAC role mapping** (`allowedRoles: ['admin']`, not `['owner', 'admin']`) and **`/health` vs
  `/ready` placement** (extended `/health`, left `/ready` untouched) both implemented exactly per
  the Dev Notes' resolved judgment calls, with tests proving the specific edge case each
  resolution was meant to cover (owner-gets-403; unauthenticated-gets-401; all three
  `extensions_status` values stay 200 on `/health`).
- **Scope discipline:** no `authStrategies`/`registerAuthStrategy()` wiring (Story 14.3's scope,
  confirmed absent from `loader.ts`), no `apps/web` changes, no `packages/extension-api` changes
  (pure consumer of Story 14.1's published `registerExtension()`/`ExtensionManifest`/
  `ExtensionRegistrationError` surface — verified no gap was found requiring a package change).
- Two small pre-existing-type widenings were needed to support fatal-equivalent logging without
  breaking any existing call site: `operationalLog()`'s logger parameter widened from a `Pick<...>`
  to a `Partial<Pick<...>>` (adding `'fatal'` as a valid level) rather than adding function
  overloads — overloads would have silently narrowed `modules/backup/routes.ts`'s
  `Parameters<typeof operationalLog>[0]`-derived type; and `lib/fastify-app.ts`'s hand-rolled
  `FastifyLogger` type gained a `fatal` method (every real Fastify/pino logger already has it).
  Both changes are additive/backward-compatible — confirmed via a full `apps/api` typecheck pass.
- Added `@project-vault/extension-api` as a runtime dependency of `apps/api` (previously
  unconsumed since Story 14.1, per that story's own Dev Notes — this story is its first
  consumer).

### File List

**New:**
- `apps/api/src/extensions/loader.ts`
- `apps/api/src/extensions/loader.test.ts`
- `apps/api/src/extensions/loader-audit.integration.test.ts`
- `apps/api/src/extensions/status-routes.ts`
- `apps/api/src/extensions/status-routes.test.ts`
- `apps/api/src/extensions/boot.test.ts`

**Modified:**
- `apps/api/src/config/env.ts` (+ `env.test.ts`)
- `apps/api/.env.example` (repo root `.env.example`)
- `apps/api/src/routes/health.ts` (+ `health.test.ts`)
- `apps/api/src/app.ts`
- `apps/api/src/lib/logger.ts` (+ `logger.test.ts`)
- `apps/api/src/lib/fastify-app.ts`
- `apps/api/package.json` (added `@project-vault/extension-api` dependency)
- `packages/shared/src/constants/audit-events.ts` (+ `audit-events.test.ts`)
- `packages/shared/src/constants/operational-event-types.ts` (+ `operational-event-types.test.ts`)
- `pnpm-lock.yaml` (dependency addition)

## Change Log

- 2026-07-24: Implemented via bmad-dev-story, TDD red-green throughout. All 6 ACs (AC-3 with all
  5 lettered sub-cases 3a-3e) satisfied; all 9 tasks/subtasks complete. `apps/api/src/extensions/`
  new subsystem (loader.ts, status-routes.ts) with 6 new/changed test files, 100%/98%+ coverage
  on both new files. `packages/shared` gained `EXTENSION_LOADED`/`EXTENSION_LOAD_FAILED` audit
  events and two new operational-event constants. `GET /health` gained an additive
  `extensions_status` field; new `GET /api/v1/admin/extensions/status` route registered at
  `ADMIN_PREFIX`. Status: in-progress → review.
