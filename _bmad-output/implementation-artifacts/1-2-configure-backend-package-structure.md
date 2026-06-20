# Story 1.2: Configure Backend Package Structure

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a developer building the API and data layers,
I want the `apps/api`, `packages/db`, `packages/crypto`, and `packages/shared` packages fully configured with their dependencies, TypeScript paths, and inter-package references,
so that feature stories can import from shared packages without any build or resolution errors.

## Acceptance Criteria

1. `apps/api` has Fastify v5 installed with: `@fastify/swagger`, `@fastify/rate-limit`, `@fastify/jwt`, `@fastify/type-provider-zod`, `@fastify/cors`, `@fastify/helmet`. [Source: _bmad-output/planning-artifacts/epics.md#Story-1.2-Configure-Backend-Package-Structure]

2. `packages/db` has Drizzle ORM 0.45.x installed with `postgres.js` driver and `drizzle-kit`; `drizzle.config.ts` points to `src/schema/index.ts` and a migrations directory; `pnpm db:migrate` runs `drizzle-kit migrate` against the configured database URL. [Source: _bmad-output/planning-artifacts/epics.md#Story-1.2-Configure-Backend-Package-Structure]

3. `packages/crypto` preserves the project-approved typed crypto stub surface for later implementation in Story 1.5 without introducing third-party crypto libraries: `EncryptedValue`, `SecretValue`, and `withSecret()` remain the stable public contract in this story. [Source: _bmad-output/planning-artifacts/epics.md#Story-1.2-Configure-Backend-Package-Structure] [Source: _bmad-output/planning-artifacts/architecture.md#Authentication--Security] [Source: packages/crypto/src/index.ts]

4. `packages/shared` exports canonical Zod-backed API envelope types used by backend routes and OpenAPI generation:
   - `ApiResponse<T>` → `{ data: T, meta?: { page?, limit?, total?, hasNext? } }`
   - `ApiError` → `{ code: string, message: string, details?: Record<string, string[]> }`, where `code` remains lower `snake_case`
   - Fastify route schemas are compatible with `@fastify/type-provider-zod` so future OpenAPI spec generation includes the shared error shape. [Source: _bmad-output/planning-artifacts/epics.md#Story-1.2-Configure-Backend-Package-Structure] [Source: _bmad-output/planning-artifacts/architecture.md#API--Communication-Patterns]

5. `apps/api` imports from `@project-vault/shared` and `@project-vault/db` via workspace protocol with TypeScript resolution passing from the repo root. [Source: _bmad-output/planning-artifacts/epics.md#Story-1.2-Configure-Backend-Package-Structure]

6. `apps/api` runs in watch mode through `tsx`, and `turbo dev` starts the API alongside the web app. Preserve the current Story 1.1 entrypoint (`src/main.ts`) rather than introducing a parallel `src/index.ts`. [Source: _bmad-output/planning-artifacts/epics.md#Story-1.2-Configure-Backend-Package-Structure] [Source: _bmad-output/implementation-artifacts/1-1-initialize-turborepo-monorepo-with-full-quality-gate-suite.md#Dev-Agent-Record]

7. pg-boss 12.18.2 is wired through the existing `BossService` stub and Fastify lifecycle without scheduling real jobs yet. [Source: _bmad-output/planning-artifacts/epics.md#Story-1.2-Configure-Backend-Package-Structure] [Source: _bmad-output/planning-artifacts/architecture.md#Starter-Template-Evaluation]

8. `turbo build`, `turbo test`, and `turbo typecheck` pass with all inter-package imports resolving correctly. Existing Story 1.1 smoke tests remain green or are updated only where package-surface changes require it. [Source: _bmad-output/planning-artifacts/epics.md#Story-1.2-Configure-Backend-Package-Structure] [Source: _bmad-output/implementation-artifacts/1-1-initialize-turborepo-monorepo-with-full-quality-gate-suite.md#Completion-Notes-List]

## Tasks / Subtasks

- [x] Task 1: Finish workspace dependency and script wiring for backend packages (AC: #1, #2, #5, #6, #7)
  - [x] Add the missing runtime dependencies to `apps/api/package.json`, especially `@fastify/rate-limit` and `@fastify/jwt`, while preserving the Story 1.1 stack already installed.
  - [x] Treat this story as package-readiness work only: do not implement full JWT auth flows, real rate-limit policy rollout, or feature routes owned by later stories.
  - [x] Keep all internal package references on `workspace:*` and confirm package entry/export fields still resolve from repo root builds.
  - [x] Make the package export strategy explicit where touched: preserve or correct `main`/`exports` fields intentionally so TypeScript consumers and runtime builds resolve the same package surface without ad-hoc deep imports.
  - [x] Preserve `apps/api/src/main.ts` as the API entrypoint; if script names or watch commands change, do not introduce a competing `src/index.ts`.
  - [x] Ensure `BossService` remains the single pg-boss integration point used by `main.ts`/`app.ts`, with lifecycle hooks wired but no production jobs scheduled yet.

- [x] Task 2: Align `packages/db` with the migration and package-boundary contract (AC: #2, #5, #8)
  - [x] Keep `packages/db/drizzle.config.ts` pointed at `src/schema/index.ts` and `packages/db/src/migrations/`; create the directory if needed instead of leaving the path implicit, and commit an empty placeholder if no migrations exist yet.
  - [x] Verify `pnpm db:migrate` continues to run `drizzle-kit migrate` from the root script and from the package itself.
  - [x] Preserve the Story 1.1 stub transaction helpers (`withOrg`, `withOrgReadScope`, `withAdminAccess`, `Tx`, `withTestOrg`) so Story 1.4 can extend them rather than replace them.
  - [x] Do not invent schema tables in this story; this is package-structure work, not database-foundation work.

- [x] Task 3: Lock the shared contract surface for API and OpenAPI consumers (AC: #4, #5, #8)
  - [x] Confirm `packages/shared/src/schemas/api.ts` is the canonical home of `ApiResponse` and `ApiError`, and tighten any typing/schema details needed to match the architecture contract.
  - [x] Export the shared contract surface cleanly from `packages/shared/src/index.ts` so `apps/api` can consume it without deep relative imports.
  - [x] Prepare `apps/api` route/schema plumbing to use `@fastify/type-provider-zod` and the shared envelope types without attempting full feature-route implementation yet; do not duplicate response/error envelope shapes locally in `apps/api`.
  - [x] Keep `apps/api/src/scripts/generate-spec.ts` compatible with the shared contract surface and future real OpenAPI generation, but do not replace the Story 1.1 stub with a full runtime OpenAPI export in this story.

- [x] Task 4: Preserve the approved crypto abstraction instead of introducing the wrong one (AC: #3, #8)
  - [x] Keep `packages/crypto` free of third-party crypto libraries.
  - [x] Preserve the Story 1.1 `EncryptedValue`, `SecretValue`, and `withSecret()` placeholder surface as the architecture-approved stub for Story 1.5.
  - [x] If the package manifest or exports need adjustment for downstream consumers, make the smallest change that keeps the approved API stable.
  - [x] Do **not** introduce a public bare `decrypt()` helper that returns plaintext; architecture forbids it.

- [x] Task 5: Add or update backend-structure smoke coverage (AC: #4, #7, #8)
  - [x] Update package smoke tests only where the public package surface changes.
  - [x] Add focused assertions for any new shared-contract exports, dependency wiring, or BossService lifecycle behavior introduced by this story.
  - [x] Keep the existing Story 1.1 health/ready/metrics tests passing unchanged unless this story intentionally alters setup code they depend on.

- [x] Task 6: Verify end-to-end package resolution from the monorepo root (AC: #5, #6, #8)
  - [x] Run the existing root quality commands relevant to this story: `pnpm typecheck`, `pnpm build`, and `pnpm test`.
  - [x] Confirm `turbo dev` still starts the API and web apps with the current monorepo entrypoints and workspace wiring.
  - [x] Fix resolution or export-path issues at the package boundary rather than patching consumers with relative-import workarounds.

## Dev Notes

### Story Intent

This story is **not** feature delivery. It is the package-boundary and dependency-alignment step between Story 1.1 scaffolding and Story 1.3+ feature work. Optimize for stable exports, correct dependencies, and predictable resolution from the monorepo root.

### Current Repo Starting Point

- Story 1.1 already created the target packages and basic smoke coverage. Start from the current files instead of recreating package scaffolds. [Source: _bmad-output/implementation-artifacts/1-1-initialize-turborepo-monorepo-with-full-quality-gate-suite.md#File-List]
- `apps/api/package.json` already contains Fastify, Swagger, CORS, Helmet, Type Provider Zod, `pg-boss`, `postgres`, `prom-client`, and workspace refs to `@project-vault/db` and `@project-vault/shared`; the obvious missing API dependencies from the epic AC are `@fastify/rate-limit` and `@fastify/jwt`. [Source: apps/api/package.json]
- `packages/db` already has `drizzle-orm`, `postgres`, `drizzle-kit`, `drizzle.config.ts`, and the Story 1.1 transaction helper stubs. Extend these; do not replace them wholesale. [Source: packages/db/package.json] [Source: packages/db/drizzle.config.ts] [Source: packages/db/src/index.ts]
- `packages/shared` already exports `ApiResponseSchema`, `ApiResponse`, `ApiErrorSchema`, and `ApiError`; this story should harden and standardize that contract, not move it elsewhere. [Source: packages/shared/src/schemas/api.ts] [Source: packages/shared/src/index.ts]
- `packages/crypto` already exposes the architecture-approved `EncryptedValue`, `SecretValue`, and `withSecret()` stubs. Preserve that direction for Story 1.5 compatibility. [Source: packages/crypto/src/index.ts]

### Architecture Guardrails

- Use TypeScript across all packages; keep package boundaries inside the Turborepo/pnpm workspace model. [Source: _bmad-output/planning-artifacts/architecture.md#Starter-Template-Evaluation]
- Fastify remains the backend framework. OpenAPI generation must continue to flow from Fastify route definitions via `@fastify/swagger`; shared Zod schemas are the source of truth for request/response contracts. [Source: _bmad-output/planning-artifacts/architecture.md#Starter-Template-Evaluation] [Source: _bmad-output/planning-artifacts/architecture.md#API--Communication-Patterns]
- pg-boss 12.18.2 is the background-processing choice and runs in the same API process, registered at startup. This story should keep the integration stubbed and lifecycle-safe rather than adding real jobs early. [Source: _bmad-output/planning-artifacts/architecture.md#Starter-Template-Evaluation] [Source: _bmad-output/planning-artifacts/architecture.md#API--Communication-Patterns]
- `packages/shared` is the single source of truth for shared API schemas/types; `packages/db` is the single source of truth for database types and Drizzle schema definitions. Do not duplicate these contracts inside `apps/api`. [Source: _bmad-output/planning-artifacts/architecture.md#Starter-Template-Evaluation]
- Backend structure should trend toward `modules/{feature}/`, `plugins/`, `workers/`, and `lib/` organization under `apps/api/src/`, but Story 1.2 only needs foundational wiring that unblocks later stories. Do not prebuild full feature modules here. [Source: _bmad-output/planning-artifacts/architecture.md#Implementation-Patterns--Consistency-Rules] [Source: _bmad-output/planning-artifacts/architecture.md#Complete-Project-Directory-Structure]
- Where this story touches package manifests, treat `main`/`exports` as an architectural boundary: changes must preserve a single intentional public package surface for both workspace consumers and built/runtime consumers. Do not leave mixed source-vs-dist semantics by accident.

### Conflict Resolution Notes

- **API entrypoint conflict:** Epic 1.2 says `tsx watch src/index.ts`, but Story 1.1 implemented and tested `src/main.ts`. Treat the AC as “watch mode is configured” and keep `src/main.ts` as the canonical entrypoint to avoid breaking existing scripts, Docker builds, and tests. [Source: _bmad-output/planning-artifacts/epics.md#Story-1.2-Configure-Backend-Package-Structure] [Source: apps/api/package.json] [Source: _bmad-output/implementation-artifacts/1-1-initialize-turborepo-monorepo-with-full-quality-gate-suite.md#Debug-Log-References]
- **Crypto API conflict:** Epic 1.2 mentions placeholder `encrypt()` / `decrypt()` exports, but the architecture forbids bare decrypt-style APIs and Story 1.1 already established `withSecret()` + `SecretValue`. Architecture wins here; preserve the approved surface and document that Story 1.5 implements real crypto behind it. [Source: _bmad-output/planning-artifacts/epics.md#Story-1.2-Configure-Backend-Package-Structure] [Source: _bmad-output/planning-artifacts/architecture.md#Authentication--Security] [Source: packages/crypto/src/index.ts]
- **Config file naming conflict:** Architecture examples sometimes refer to `apps/api/src/config.ts`, while Story 1.1 implemented `apps/api/src/config/env.ts`. Keep the existing `config/env.ts` location unless a wider rename is required across the repo; do not create duplicate env access points. [Source: _bmad-output/planning-artifacts/architecture.md#Complete-Project-Directory-Structure] [Source: _bmad-output/implementation-artifacts/1-1-initialize-turborepo-monorepo-with-full-quality-gate-suite.md#Acceptance-Criteria]
- **Environment ownership conflict:** Architecture wants env access centralized, but current `packages/db` code already touches `DATABASE_URL`. Story 1.2 should not expand env access into more shared-package files; if touching this area, reduce ambiguity or contain it rather than spreading it. [Source: _bmad-output/planning-artifacts/architecture.md#Complete-Project-Directory-Structure] [Source: packages/db/src/index.ts] [Source: packages/db/drizzle.config.ts]

### Previous Story Intelligence

- Story 1.1 already validated the monorepo quality gates and package structure. Story 1.2 should build on those established paths instead of moving files around. [Source: _bmad-output/implementation-artifacts/1-1-initialize-turborepo-monorepo-with-full-quality-gate-suite.md#Completion-Notes-List]
- `apps/web/tsconfig.json` intentionally extends `@project-vault/tsconfig/svelte.json` directly instead of `.svelte-kit/tsconfig.json` to keep Stryker sandbox compatibility. Do not “correct” this during backend package work. [Source: _bmad-output/implementation-artifacts/1-1-initialize-turborepo-monorepo-with-full-quality-gate-suite.md#Debug-Log-References]
- Story 1.1 restricted jscpd scanning to `apps packages scripts` to avoid pnpm symlink noise. New files in this story should stay within that expected repo structure. [Source: _bmad-output/implementation-artifacts/1-1-initialize-turborepo-monorepo-with-full-quality-gate-suite.md#Debug-Log-References]
- Docker, CI, and health/readiness behavior were already fixed after Story 1.1 review. Avoid changing those surfaces unless package-boundary work forces it. [Source: _bmad-output/implementation-artifacts/1-1-initialize-turborepo-monorepo-with-full-quality-gate-suite.md#Review-Findings]
- Story 1.2 is allowed to strengthen `BossService` signatures and dependency wiring, but not to introduce real worker registration, cron schedules, queue names, or business jobs ahead of the feature stories that own them.

### Git Intelligence

- Recent repo history shows the current baseline was established in `chore: initial setup`, then corrected in `fix: fixes problem with docker`. That means Story 1.2 should assume the workspace and Docker paths now reflect the intended baseline, and any package changes should preserve those working paths. [Source: git log -5 on 2026-06-15]

### Files Most Likely to Change

- `apps/api/package.json`
- `apps/api/src/app.ts`
- `apps/api/src/main.ts`
- `apps/api/src/lib/boss.ts`
- `apps/api/src/scripts/generate-spec.ts`
- `apps/api/vitest.config.ts` and targeted API smoke tests if package-surface changes require updates
- `packages/db/package.json`
- `packages/db/drizzle.config.ts`
- `packages/db/src/index.ts`
- `packages/db/src/test-helpers.ts`
- `packages/shared/src/schemas/api.ts`
- `packages/shared/src/index.ts`
- `packages/crypto/package.json`
- `packages/crypto/src/index.ts`

### Testing Requirements

- Reuse the Vitest setup established in Story 1.1 (`mergeConfig(baseVitestConfig, ...)`) instead of inventing a new test harness. [Source: _bmad-output/implementation-artifacts/1-1-initialize-turborepo-monorepo-with-full-quality-gate-suite.md#Acceptance-Criteria]
- Keep package smoke tests small and boundary-focused: public exports, package resolution, and lifecycle wiring rather than full feature behavior.
- Root verification for this story is `pnpm lint && pnpm typecheck && pnpm build && pnpm test`. If a change affects runtime startup, also check `pnpm dev`/`turbo dev` behavior at the package-script level. [Source: package.json]
- Because this story changes package manifests and boundary wiring, include `pnpm lint` in the verification set alongside `typecheck`, `build`, and `test`.

### Project Structure Notes

- Align with the existing monorepo layout created in Story 1.1: `apps/api`, `apps/web`, `packages/db`, `packages/crypto`, `packages/shared`, `packages/tsconfig`, `packages/eslint-config`. [Source: _bmad-output/implementation-artifacts/1-1-initialize-turborepo-monorepo-with-full-quality-gate-suite.md#File-List]
- No `project-context.md` exists in the repo, so the story should rely on planning artifacts plus the already-created Story 1.1 implementation artifact for local conventions.
- Keep package exports and imports explicit. Do not patch resolution issues with deep relative imports across package boundaries.

### References

- Epic 1 story definitions [Source: _bmad-output/planning-artifacts/epics.md#Epic-1-Vault-Foundation--Deployment-Authentication--Core-Platform]
- Story 1.2 requirements [Source: _bmad-output/planning-artifacts/epics.md#Story-1.2-Configure-Backend-Package-Structure]
- Starter template and package decisions [Source: _bmad-output/planning-artifacts/architecture.md#Starter-Template-Evaluation]
- Authentication and crypto constraints [Source: _bmad-output/planning-artifacts/architecture.md#Authentication--Security]
- API/OpenAPI/shared-schema patterns [Source: _bmad-output/planning-artifacts/architecture.md#API--Communication-Patterns]
- Backend structure and consistency rules [Source: _bmad-output/planning-artifacts/architecture.md#Implementation-Patterns--Consistency-Rules]
- Project structure and boundaries [Source: _bmad-output/planning-artifacts/architecture.md#Project-Structure--Boundaries]
- Current baseline and learnings from Story 1.1 [Source: _bmad-output/implementation-artifacts/1-1-initialize-turborepo-monorepo-with-full-quality-gate-suite.md]

## Dev Agent Record

### Agent Model Used

GPT-5.4 (gpt-5.4)

### Debug Log References

- Story created from sprint status key `1-2-configure-backend-package-structure`.
- No `project-context.md` found in repository.
- Resolved two source conflicts in favor of established architecture/repo reality: `src/main.ts` vs `src/index.ts`, and `withSecret()` crypto stub vs bare `decrypt()` export.
- Restored Fastify v5 ESM compatibility with a local app-surface shim so `@fastify/swagger` and `@fastify/type-provider-zod` could be wired without changing runtime behavior.
- `pnpm db:migrate` and `pnpm --filter @project-vault/db db:migrate` both reached `drizzle-kit migrate`; execution stopped only when no local Postgres server was available.
- `pnpm dev` now launches both `@project-vault/api` and `@project-vault/web`; Turbo env forwarding was fixed via `globalEnv`, and the API halts only on the expected local Postgres connection refusal in this environment.

### Completion Notes List

- Added the missing Fastify backend dependencies, upgraded the workspace Zod surface to v4, and made package entrypoints resolve from built `dist` artifacts for runtime-safe workspace imports.
- Wired Fastify swagger and Zod compilers in `apps/api`, added shared API contract helpers for future route modules, and hardened the canonical `ApiError`/`ApiResponse` schemas in `packages/shared`.
- Converted `BossService` into an idempotent pg-boss lifecycle wrapper, preserved the existing crypto and DB stub contracts, added a placeholder migrations directory, and expanded smoke coverage for package boundaries and boss lifecycle behavior.
- Verified the story quality gates with `pnpm lint && pnpm typecheck && pnpm build && pnpm test`.

### File List

- _bmad-output/implementation-artifacts/1-2-configure-backend-package-structure.md
- _bmad-output/implementation-artifacts/sprint-status.yaml
- apps/api/package.json
- apps/api/src/@types/fastify-compat.d.ts
- apps/api/src/app.ts
- apps/api/src/config/env.ts
- apps/api/src/lib/api-contracts.test.ts
- apps/api/src/lib/api-contracts.ts
- apps/api/src/lib/boss.test.ts
- apps/api/src/lib/boss.ts
- apps/api/src/lib/fastify-app.ts
- apps/api/src/lib/shutdown.ts
- apps/api/src/main.ts
- apps/api/src/routes/health.ts
- apps/api/src/routes/metrics.ts
- packages/crypto/package.json
- packages/db/package.json
- packages/db/src/migrations/.gitkeep
- packages/shared/package.json
- packages/shared/src/schemas/api.test.ts
- packages/shared/src/schemas/api.ts
- pnpm-lock.yaml
- turbo.json

### Change Log

- 2026-06-15: Completed Story 1.2 by wiring backend package dependencies and exports, adding shared Zod/OpenAPI contract plumbing, hardening pg-boss lifecycle integration, and fixing Turbo dev env forwarding for API startup.
