# Story 1.3: Docker Deployment & Health Endpoints

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a platform operator deploying Project Vault on self-hosted infrastructure,
I want the full application stack deployable with a single `docker compose up` command, with the multi-arch build, image-size, and CORS guarantees that the README already advertises actually enforced and tested,
so that I can run a production-grade vault without installing Node.js or build tools on the host, and trust the documented operational guarantees instead of discovering gaps in production.

> ⚠️ **Read this before starting any task below.** Story 1.1 ("Initialize Turborepo Monorepo with Full Quality Gate Suite") front-loaded almost the entire Docker/health/security surface described in `epics.md` Story 1.3 — Dockerfiles, `docker-compose*.yml`, `/health`, `/ready`, `/metrics`, Helmet, CORS, env validation, and `.env.example` parity checking all already exist and pass. **Do not re-implement any of this.** This story's real scope is: (1) verify the existing implementation against every AC below, and (2) close the specific, concrete gaps identified during story creation (CI multi-arch validation, image-size enforcement, a missing CORS test, incorrect `docker-compose.prod.yml` resource values, and two documentation accuracy issues). Treat anything marked `[VERIFY]` as regression-check-only and anything marked `[IMPLEMENT]` as the actual delivery work.

## Acceptance Criteria

*Covers: FR49, FR81* [Source: _bmad-output/planning-artifacts/epics.md#Story-1.3-Docker-Deployment--Health-Endpoints]

1. **[VERIFY]** `docker compose up --build` starts three services — `db` (PostgreSQL 16), `api` (Fastify), `web` (SvelteKit) — all reaching healthy status within 60 seconds. [Source: docker-compose.yml]

2. **[VERIFY]** `apps/api/Dockerfile` uses a multi-stage build (`builder` → `runner`); only compiled `dist/` output and `--prod` `node_modules` are copied into the runner stage. **[IMPLEMENT — gap]** No automated check currently enforces the "final image size must be under 300MB" requirement. Add a CI step (or `scripts/check-image-size.ts`) that builds the `api` and `web` images and fails the build if either exceeds 300MB, e.g.:
   ```bash
   SIZE=$(docker image inspect project-vault-api:ci --format='{{.Size}}')
   if [ "$SIZE" -gt $((300 * 1024 * 1024)) ]; then
     echo "FATAL: project-vault-api image is ${SIZE} bytes, exceeds 300MB limit"; exit 1
   fi
   ```
   [Source: apps/api/Dockerfile; _bmad-output/planning-artifacts/epics.md#Story-1.3-Docker-Deployment--Health-Endpoints]

3. **[VERIFY]** `apps/web/Dockerfile` uses SvelteKit's Node adapter; no separate Nginx is introduced. [Source: apps/web/Dockerfile]

4. **[VERIFY]** Both Dockerfiles pin their base image to the exact digest established in Story 1.1 (`node:24-alpine@sha256:2bdb65ed1dab192432bc31c95f94155ca5ad7fc1392fb7eb7526ab682fa5bf14`). Do not change this digest in this story — that is the job of `scripts/update-base-image.sh` on its own weekly cadence. [Source: apps/api/Dockerfile; apps/web/Dockerfile]

5. **[VERIFY]** `GET /health` always returns `200 { status: "ok", version: "<semver from package.json>" }` while the process is alive and never checks the database (pure liveness probe). [Source: apps/api/src/routes/health.ts]

6. **[VERIFY]** `GET /ready` returns `200 { status: "ready" }` when a `SELECT 1` against the DB pool succeeds, or `503 { status: "unavailable", reason: "db", retryAfter: 5 }` when it fails or no pool is configured. Confirm `apps/api/src/main.ts` actually constructs and passes a real `dbPool` into `createApp()` at runtime — `createApp({ dbPool })` defaults to `undefined`, which always returns 503. [Source: apps/api/src/routes/health.ts; apps/api/src/app.ts; apps/api/src/main.ts]

7. **[VERIFY]** The `db` container declares a `HEALTHCHECK` using `pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}`; the `api` container declares `depends_on: db: condition: service_healthy`. [Source: docker-compose.yml]

8. **[VERIFY]** The `api` container's `HEALTHCHECK` polls `GET /health` every 10 seconds, 3 retries, 30-second start period — declared both in `docker-compose.yml` and again as a Docker-native `HEALTHCHECK` instruction in `apps/api/Dockerfile`. [Source: docker-compose.yml; apps/api/Dockerfile]

9. **[VERIFY]** All configuration is injected via environment variables; `.env.example` documents `DATABASE_URL` (with both local-dev and in-Docker variants), `API_PORT` (default 3000), `WEB_PORT` (default 5173), `NODE_ENV`, plus the additional vars already established beyond the epic's literal AC text: `CORS_ALLOWED_ORIGINS`, `METRICS_BIND_HOST`, `LOG_LEVEL`. [Source: .env.example]

10. **[VERIFY]** `pnpm docker:smoke` exits 0 against the built stack and tears down containers via `trap "docker compose down" EXIT` even on failure (this `trap` was added specifically to fix a Story 1.1 review finding — do not remove it). [Source: package.json#docker:smoke]

11. **[IMPLEMENT — real gap]** Multi-arch build (`linux/amd64` + `linux/arm64`) must actually be validated in CI, not just claimed in the README. Today `.github/workflows/ci.yml`'s `docker-build` job (lines 108–127) only builds the `api` image, with no `platforms:` key (so it only builds for the runner's native platform), and never builds or validates the `web` image at all. Required fix:
    - Add `platforms: linux/amd64,linux/arm64` to the existing `docker/build-push-action@v6` step for `apps/api/Dockerfile`.
    - Add an equivalent build step for `apps/web/Dockerfile` with the same `platforms` value.
    - Confirm `docker/setup-buildx-action@v3` explicitly sets `driver: docker-container` (the driver required for multi-platform builds — do not rely on the action's default without stating it, since Story 1.1's local instructions explicitly call out `docker buildx create --use --driver docker-container`).
    - Keep `push: false` (CI validates buildability only; this story does not introduce a registry push pipeline — see Conflict Resolution Notes).
    [Source: .github/workflows/ci.yml#docker-build; _bmad-output/implementation-artifacts/1-1-initialize-turborepo-monorepo-with-full-quality-gate-suite.md#Dev-Notes; _bmad-output/planning-artifacts/epics.md#Definition-of-Done]

12. **[VERIFY]** `GET /metrics` is bound to `localhost`/loopback only by default (rejecting non-loopback requests with `403`, already covered by `metrics.test.ts`), returns valid Prometheus text format, and includes at minimum `process_uptime_seconds`, `http_requests_total`, `http_request_duration_ms`. [Source: apps/api/src/routes/metrics.ts; apps/api/src/routes/metrics.test.ts]

13. **[VERIFY]** `@fastify/helmet` is registered with the explicit (non-default) configuration: `contentSecurityPolicy` with `default-src 'self'`, `script-src 'self'`, `style-src 'self' 'unsafe-inline'`, `img-src 'self' data:`; `strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true }`; `frameguard: { action: 'deny' }`; `referrerPolicy: { policy: 'strict-origin-when-cross-origin' }`. [Source: apps/api/src/app.ts]

14. **[IMPLEMENT — real gap]** `@fastify/cors` is already registered with `origin` resolved from `CORS_ALLOWED_ORIGINS` (no service code change needed), but **no automated test exists** proving the contract the epic explicitly requires. Add a test that asserts:
    - A request with an `Origin` header **not** present in `CORS_ALLOWED_ORIGINS` receives `403` (or the CORS error Fastify surfaces for a rejected origin — assert the actual status Fastify returns, do not assume).
    - A request with an `Origin` header that **is** in `CORS_ALLOWED_ORIGINS` receives a response with `Access-Control-Allow-Origin` matching that exact origin.
    Example shape (adapt to the existing `light-my-request`/`inject` pattern used in `health.test.ts`/`metrics.test.ts`):
    ```ts
    it('rejects requests from an unlisted origin', async () => {
      const app = await createApp({ logger: false })
      const res = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'http://evil.example.com' } })
      expect(res.statusCode).toBe(403)
    })

    it('allows requests from an allow-listed origin', async () => {
      const app = await createApp({ logger: false })
      const res = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'http://localhost:5173' } })
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173')
    })
    ```
    [Source: apps/api/src/app.ts; _bmad-output/planning-artifacts/epics.md#Story-1.3-Docker-Deployment--Health-Endpoints]

15. **[VERIFY]** `apps/api/src/config/env.ts` exports a Zod schema parsed at startup; on any missing/invalid required variable the process exits with code 1 and a human-readable error. **Note on wording:** the epic's illustrative error string is `FATAL: missing required environment variables: DATABASE_URL, JWT_SECRET`, but the current implementation already writes a more detailed per-field listing (`Missing or invalid environment variables:\n  - <path>: <message>`). **Decision: keep the existing, more informative format** — the epic text is illustrative, not a literal contract, and the current format is strictly more useful for an operator. Do not rewrite it to match the epic's exact string. [Source: apps/api/src/config/env.ts]

16. **[VERIFY]** `scripts/check-env-example.ts` parses both `.env.example` and the Zod schema's key names and fails if the schema has any key absent from `.env.example`; confirm this still runs as a CI step. [Source: scripts/check-env-example.ts]

17. **[IMPLEMENT — real gap, data correction]** `docker-compose.prod.yml` exists but its values **do not match** the epic's production-hardening spec. Current file vs. required:

    | Setting | Current | Required |
    |---|---|---|
    | `db.mem_limit` | `512m` | `1g` |
    | `api.mem_limit` | `256m` | `512m` |
    | `web.mem_limit` | `128m` | `256m` |
    | `*.logging.options.max-file` | `"3"` | `"5"` |
    | `api.cpu_shares` | `512` | `512` ✅ already correct |
    | `*.restart` | `unless-stopped` | ✅ already correct |
    | `*.logging.options.max-size` | `"10m"` | ✅ already correct |

    Fix the four mismatched values. Re-run `docker compose -f docker-compose.yml -f docker-compose.prod.yml config` after editing to confirm the merge is still valid YAML and resolves as expected. [Source: docker-compose.prod.yml; _bmad-output/planning-artifacts/epics.md#Story-1.3-Docker-Deployment--Health-Endpoints]

18. **[VERIFY — document, do not "fix"]** Named volumes `db_data` and `vault_keys` already replace bind mounts in `docker-compose.prod.yml`. `vault_keys` is declared but **intentionally not yet mounted into any service** — no story before 1.5 (Vault Initialization & Master Key Management) needs it mounted. Add a one-line comment in `docker-compose.prod.yml` next to the `vault_keys` volume declaration noting it is reserved for Story 1.5, so a future reviewer doesn't flag it as dead config. [Source: docker-compose.prod.yml; _bmad-output/planning-artifacts/epics.md#Epic-1-Vault-Foundation--Deployment-Authentication--Core-Platform]

19. **[IMPLEMENT — small doc gap]** README's production usage example (`docker compose -f docker-compose.yml -f docker-compose.prod.yml up`) is missing the `-d` (detached) flag that the epic AC specifies for production operation. Update the README command to `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`. [Source: README.md#Production-Usage; _bmad-output/planning-artifacts/epics.md#Story-1.3-Docker-Deployment--Health-Endpoints]

20. **[IMPLEMENT — doc/CI honesty gap]** README's CI Quality Gates table currently states `Docker | CI only | Multi-arch build validation`, which is **not true today** (see AC #11). Once AC #11 is implemented this claim becomes accurate — no README change is then needed beyond confirming it. If multi-arch CI validation is for any reason descoped during implementation, this README row must be corrected instead of left as an inaccurate claim. [Source: README.md#CI-Quality-Gates]

21. **[VERIFY — Definition of Done gate]** Per the project-wide Definition of Done, "Multi-arch build succeeds: `linux/amd64` and `linux/arm64`" is a non-negotiable CI gate for every story, not just this one — this story is what actually wires that gate into CI for the first time. [Source: _bmad-output/planning-artifacts/epics.md#Definition-of-Done]

## Tasks / Subtasks

- [x] Task 1: Regression-verify the existing Docker/health/security baseline — make NO functional changes here (AC: #1, #3, #4, #5, #6, #7, #8, #9, #10, #12, #13, #15, #16)
  - [x] Run `docker compose up --build` from a cold state; confirm all three services report healthy within 60s.
  - [x] Run `pnpm docker:smoke`; confirm it exits 0 and that `docker compose down` runs even if you simulate a failure (e.g., temporarily break `/ready`).
  - [x] Confirm `apps/api/src/main.ts` wires a real `dbPool` into `createApp()` so `/ready` can actually reach `"ready"` against the running `db` container, not just 503 by default — fix only if this specific wiring is broken; do not redesign `main.ts`.
  - [x] Confirm `pnpm tsx scripts/check-env-example.ts` passes and is still invoked in `.github/workflows/ci.yml`.
  - [x] Confirm `apps/api/src/routes/health.test.ts` and `apps/api/src/routes/metrics.test.ts` still pass unchanged.

- [x] Task 2: Wire real multi-arch build validation into CI (AC: #11, #21)
  - [x] In `.github/workflows/ci.yml`, add `platforms: linux/amd64,linux/arm64` to the `docker-build` job's existing `docker/build-push-action@v6` step that builds `apps/api/Dockerfile`.
  - [x] Add a parallel build step in the same job (or a second job) that builds `apps/web/Dockerfile` with the same `platforms` value — today the web image is never built in CI at all.
  - [x] Explicitly set `driver: docker-container` on the `docker/setup-buildx-action@v3` step.
  - [x] Keep `push: false` for both steps — this story validates buildability only (see Dev Notes on registry push scope).
  - [x] Confirm GHA build caching (`cache-from`/`cache-to: type=gha`) still works per-image when multi-platform; use separate `scope` values per image if cache collisions occur.

- [x] Task 3: Enforce the 300MB image-size limit in CI (AC: #2)
  - [x] Add a CI step (or a small `scripts/check-image-size.ts`) that inspects the built `api` and `web` images and fails if either exceeds `300 * 1024 * 1024` bytes.
  - [x] Run it against the locally-built images first to confirm both are currently under the limit before wiring it into CI as a hard gate.

- [x] Task 4: Close the CORS test gap (AC: #14)
  - [x] Add a test (in `apps/api/src/lib/` or alongside `health.test.ts`, matching existing project conventions) asserting `403` for a request from an origin not in `CORS_ALLOWED_ORIGINS`.
  - [x] Add a test asserting the `Access-Control-Allow-Origin` response header exactly matches an allow-listed origin.
  - [x] Do not change `app.ts`'s CORS registration logic unless a test reveals it doesn't actually behave as the epic requires — the current implementation is believed correct, only untested.

- [x] Task 5: Correct `docker-compose.prod.yml` resource and logging values (AC: #17, #18)
  - [x] Set `db.mem_limit: 1g`.
  - [x] Set `api.mem_limit: 512m`.
  - [x] Set `web.mem_limit: 256m`.
  - [x] Set `max-file: "5"` for all three services' logging options.
  - [x] Add a one-line comment next to the `vault_keys` volume noting it is reserved for Story 1.5.
  - [x] Run `docker compose -f docker-compose.yml -f docker-compose.prod.yml config` to confirm the merged config is valid.

- [x] Task 6: Documentation accuracy pass (AC: #19, #20)
  - [x] Update README's production usage command to include `-d`.
  - [x] Re-verify the README's "Docker | CI only | Multi-arch build validation" claim is true after Task 2 lands; correct it if descoped.

- [x] Task 7: Full quality-gate regression pass (Definition of Done)
  - [x] `pnpm lint && pnpm typecheck && pnpm build && pnpm test`
  - [x] `pnpm docker:smoke`
  - [x] Confirm Stryker mutation score on any new non-trivial logic added by this story (e.g., an image-size check script, new CORS test file) meets the current ≥60% nightly gate threshold.
  - [x] Confirm `pnpm audit --audit-level=high`, Trivy filesystem scan, and Trivy Docker image scan are unaffected by these changes.

## Dev Notes

### Story Intent

This story is **gap-closing and verification work, not greenfield Docker implementation**. Story 1.1 ("Full Quality Gate Suite") already delivered nearly everything the epic's Story 1.3 acceptance criteria describe: both Dockerfiles, `docker-compose.yml`/`docker-compose.dev.yml`/`docker-compose.prod.yml`, `/health`, `/ready`, `/metrics`, Helmet, CORS, Zod env validation, and `.env.example` parity checking. Story 1.2 then hardened the backend package boundaries around that baseline without touching Docker. Treat every "already implemented" item in the AC list as **regression-check only** — re-implementing it from scratch risks introducing regressions the Story 1.1 code review already fixed (see Previous Story Intelligence below). The actual delivery surface of this story is narrow: CI multi-arch validation, image-size enforcement, one missing CORS test, four wrong numbers in `docker-compose.prod.yml`, and two documentation corrections.

### Current Repo Starting Point

- `apps/api/Dockerfile` and `apps/web/Dockerfile` both exist, multi-stage, pinned to the same base digest. [Source: apps/api/Dockerfile; apps/web/Dockerfile]
- `docker-compose.yml` already wires `db`/`api`/`web` with correct healthchecks and `depends_on: condition: service_healthy`. [Source: docker-compose.yml]
- `apps/api/src/app.ts` already registers `@fastify/helmet` and `@fastify/cors` with the exact configuration the epic requires. [Source: apps/api/src/app.ts]
- `apps/api/src/routes/health.ts` and `apps/api/src/routes/metrics.ts` already implement the full liveness/readiness/metrics contract, including the loopback-only access control on `/metrics` that a Story 1.1 review finding specifically fixed. [Source: apps/api/src/routes/health.ts; apps/api/src/routes/metrics.ts]
- `apps/api/src/config/env.ts` already validates `NODE_ENV`, `API_PORT`, `DATABASE_URL`, `CORS_ALLOWED_ORIGINS` (with an explicit no-wildcard `refine`), `METRICS_BIND_HOST`, `LOG_LEVEL`. [Source: apps/api/src/config/env.ts]
- `scripts/check-env-example.ts` already diffs the Zod schema's keys against `.env.example` — this was added specifically to fix a Story 1.1 review finding that the original parity check only verified non-empty content. [Source: scripts/check-env-example.ts]
- `.github/workflows/ci.yml`'s `docker-build` job (lines 108–127) and `.github/workflows/nightly.yml`'s `trivy-image` job (lines 45–63) both **only ever build `apps/api/Dockerfile`**, single-platform, never `apps/web/Dockerfile`. This is the most concrete gap in the story. [Source: .github/workflows/ci.yml; .github/workflows/nightly.yml]

### Architecture Guardrails

- Deployment target is Docker/Docker Compose self-hosted, multi-arch (AMD64 + ARM64) via GitHub Actions — this story is what actually wires the CI half of that promise. [Source: _bmad-output/planning-artifacts/architecture.md#Infrastructure--Deployment]
- 12-factor: all configuration via environment variables, no hardcoded values — already satisfied; do not introduce any hardcoded config while touching `docker-compose.prod.yml`. [Source: _bmad-output/planning-artifacts/architecture.md#Infrastructure--Deployment]
- Metrics: `prom-client`, localhost-only by default, configurable for external scraping via `METRICS_BIND_HOST` — already satisfied, do not change the access-control model. [Source: _bmad-output/planning-artifacts/architecture.md#Infrastructure--Deployment]
- The architecture document states CI/CD pushes multi-arch images to GHCR **on merge to main**. This story intentionally does **not** implement registry push — only build validation (`push: false`) — because no registry/credentials decision has been made yet and the epic's Story 1.3 AC text only asks for build success, not push. Document this as an explicitly deferred scope item rather than silently skipping it. [Source: _bmad-output/planning-artifacts/architecture.md#Infrastructure--Deployment]

### Conflict Resolution Notes

- **Registry push vs. build-only CI:** Architecture mentions pushing to GHCR on merge to `main`; the epic's Story 1.3 AC only requires multi-arch *build* success. Resolution: implement build-only validation (`push: false`) in this story; registry push is out of scope until a registry/credentials decision is made — flag this explicitly in Completion Notes rather than silently doing less than the architecture doc implies.
- **Env error message wording:** The epic's AC text shows an illustrative error string (`FATAL: missing required environment variables: ...`) that differs from the more detailed per-field format already implemented in `env.ts`. Resolution: keep the existing, more informative format (see AC #15) — it is strictly more useful and changing it serves no purpose.
- **`docker-compose.prod.yml` numbers:** The file already exists with the right *shape* (per-service `mem_limit`, `cpu_shares`, `restart`, `logging`, named volumes) but wrong *values* for `mem_limit` (db/api/web) and `max-file`. Resolution: this is a straightforward data correction (AC #17), not a structural redesign.

### Previous Story Intelligence (from Story 1.2)

- Story 1.2 explicitly did **not** touch Docker, CI, or health/readiness surfaces — "Docker, CI, and health/readiness behavior were already fixed after Story 1.1 review. Avoid changing those surfaces unless package-boundary work forces it." This story is the first to legitimately revisit that surface since the Story 1.1 review fixes landed; preserve those fixes (loopback-only metrics check via `req.ip`, not `req.hostname`; `pnpm-lock.yaml` copied into Docker build context; `curl` installed in the runner image; CORS wildcard rejection in the env schema; `docker:smoke`'s `trap ... EXIT`). [Source: _bmad-output/implementation-artifacts/1-2-configure-backend-package-structure.md#Previous-Story-Intelligence]
- Story 1.2 confirmed `apps/api/src/main.ts` is the canonical entrypoint (not `src/index.ts`) — do not introduce a parallel entrypoint while wiring the real `dbPool` into `createApp()` for Task 1. [Source: _bmad-output/implementation-artifacts/1-2-configure-backend-package-structure.md#Conflict-Resolution-Notes]
- Story 1.2's Dev Agent Record confirms `pnpm dev`/`turbo dev` and `pnpm --filter @project-vault/db db:migrate` both work against the current workspace wiring — use these as known-good baselines if any task in this story needs to validate the dev (non-Docker) path didn't regress. [Source: _bmad-output/implementation-artifacts/1-2-configure-backend-package-structure.md#Debug-Log-References]

### Git Intelligence

- Recent history: `feat(setup): story 1.2 configure backend` → `fix(setup): fix security warnings` → `fix(setup): fix workflow`, merged via PR #1. The two `fix(setup)` commits following Story 1.2 suggest CI/workflow correctness has needed iteration recently — review `.github/workflows/ci.yml` carefully for any other drift while adding the multi-arch/web-image build steps in Task 2, since you'll already be editing that file. [Source: git log -5 on 2026-06-24]

### Files Most Likely to Change

- `.github/workflows/ci.yml` (multi-arch + web image build steps, possibly image-size check step)
- `docker-compose.prod.yml` (mem_limit/max-file corrections, vault_keys comment)
- `README.md` (production command `-d` flag, CI gates table accuracy)
- `apps/api/src/main.ts` (only if `dbPool` wiring into `createApp()` is found broken during Task 1 verification)
- A new test file for CORS behavior (e.g., `apps/api/src/lib/cors.test.ts` or an addition to `apps/api/src/routes/health.test.ts` — follow whichever convention keeps test files focused, matching the existing one-concern-per-file pattern in `apps/api/src/routes/`)
- Possibly a new `scripts/check-image-size.ts` (only if image-size enforcement is implemented as a script rather than an inline CI step)

### Testing Requirements

- Reuse the existing Fastify `inject()` test pattern already used in `health.test.ts` and `metrics.test.ts` for the new CORS test — do not introduce a new HTTP test harness. [Source: apps/api/src/routes/health.test.ts; apps/api/src/routes/metrics.test.ts]
- Any new non-trivial logic (CORS test assertions don't count as "logic" to mutate, but an image-size check script does) must meet the project's mutation-score expectations once touched by Stryker. [Source: _bmad-output/planning-artifacts/epics.md#Definition-of-Done]
- Root verification command for this story: `pnpm lint && pnpm typecheck && pnpm build && pnpm test`, plus `pnpm docker:smoke` since this story directly touches Docker/CI surfaces.
- No `skip`, `todo`, or `.only` markers permitted in committed test code. [Source: _bmad-output/planning-artifacts/epics.md#Definition-of-Done]

### Project Structure Notes

- No structural changes to the monorepo layout are needed for this story — all work is within existing files (`.github/workflows/`, `docker-compose.prod.yml`, `README.md`, `apps/api/src/`) or a single small new script/test file.
- No `project-context.md` exists in the repo; rely on this story file plus the cited planning artifacts and the Story 1.1/1.2 implementation artifacts for local conventions.

### References

- Epic 1 story definitions [Source: _bmad-output/planning-artifacts/epics.md#Epic-1-Vault-Foundation--Deployment-Authentication--Core-Platform]
- Story 1.3 requirements [Source: _bmad-output/planning-artifacts/epics.md#Story-1.3-Docker-Deployment--Health-Endpoints]
- Definition of Done — Docker & Deployment, Security, Testing gates [Source: _bmad-output/planning-artifacts/epics.md#Definition-of-Done]
- Infrastructure & deployment architecture decisions [Source: _bmad-output/planning-artifacts/architecture.md#Infrastructure--Deployment]
- Story 1.1 Docker/CI implementation baseline and review findings [Source: _bmad-output/implementation-artifacts/1-1-initialize-turborepo-monorepo-with-full-quality-gate-suite.md]
- Story 1.2 backend package-boundary learnings and explicit instruction to leave Docker/health surfaces alone unless forced [Source: _bmad-output/implementation-artifacts/1-2-configure-backend-package-structure.md]
- Current implementation: docker-compose.yml, docker-compose.prod.yml, apps/api/Dockerfile, apps/web/Dockerfile, apps/api/src/app.ts, apps/api/src/routes/health.ts, apps/api/src/routes/metrics.ts, apps/api/src/config/env.ts, scripts/check-env-example.ts, .github/workflows/ci.yml, .github/workflows/nightly.yml, README.md

## Dev Agent Record

### Agent Model Used

Claude Sonnet 4.6

### Debug Log References

- Cold-start `docker compose up --build` verified all three services (`db`, `api`, `web`) healthy within ~60s; `/health` returns `{"status":"ok","version":"0.0.1"}`, `/ready` returns `{"status":"ready"}` against the real `db` container, `/metrics` correctly 403s from the host (non-loopback) and 200s from inside the container (loopback).
- `pnpm docker:smoke` initially failed deterministically (curl error 56, "Recv failure: Connection reset by peer") on every run. Root-caused via timed polling: there is a ~100-300ms window right after the `api` container reports "Started" where the host's published port accepts a TCP connection but the Fastify server hasn't finished binding yet, producing a connection reset rather than a connection refused. `curl --retry-connrefused` does not cover this error class (curl exit 56), so the retry never engaged. Fixed by switching to `--retry-all-errors` in the `docker:smoke` script (`package.json`). Verified 0 exit code across repeated runs after the fix.
- `apps/api/src/main.ts` already wires a real `dbPool` into `createApp()` (confirmed by reading the file and by `/ready` returning `"ready"` against the live `db` container) — no change needed.
- Discovered both `apps/api` and `apps/web` runtime images were 447MB / 413MB — well over the 300MB AC #2 limit — before any check was wired up. Root cause: the runner stage's `npm install -g pnpm` and `pnpm install --prod` leave `/root/.cache/pnpm`, `/root/.local/share/pnpm`, and `/root/.npm` cache directories (~280MB combined) inside the final image; these were never cleaned. Fixed by appending cache cleanup to the same `RUN` layer that creates the cache (cleaning in a later layer would not reduce image size, since overlay-fs layer diffs are additive). After the fix: api image 277MB, web image 244MB — both under the 300MB limit. Re-verified the full `docker compose up` stack still starts healthy and serves `/health`/`/ready` correctly with the rebuilt images.
- Manually verified the actual CORS-rejection status code via `app.inject()` before writing assertions, per the AC's explicit instruction not to assume — Fastify's default error handler returns `500 {"statusCode":500,"error":"Internal Server Error","message":"Not allowed by CORS"}` for a rejected origin (not `403`). Test asserts this actual behavior; `app.ts`'s CORS registration was not changed.
- `docker compose -f docker-compose.yml -f docker-compose.prod.yml config` exits 0 with corrected mem_limit/max-file values. The `vault_keys` volume does not appear in the merged `config` output because Compose v5 prunes top-level volumes unreferenced by any service from that output — this is pre-existing tool behavior, unrelated to the added comment, and does not affect the validity of the merged config.
- Full regression: `pnpm turbo lint` (5/5 packages clean), `pnpm turbo typecheck` (8/8), `pnpm turbo build` (5/5), `pnpm turbo test` (7/7, 25 passed + 1 pre-existing `it.todo` unrelated to this story), `pnpm jscpd` (0 clones), `pnpm audit --audit-level=high` (exit 0, only low/moderate findings), `pnpm tsx scripts/check-audit-baseline.ts` (passed), `pnpm generate-spec` freshness check (no diff).
- Stryker: `scripts/check-image-size.ts` falls under the existing `!**/scripts/**` exclusion in `stryker.config.mjs` (same exclusion already applied to `check-env-example.ts` and `check-audit-baseline.ts`), so it is not a new mutation-testing target — consistent with existing project convention for operational scripts vs. domain logic. No Stryker config change made.
- Trivy filesystem/image scans could not be run locally (`trivy` CLI not installed in this environment); assessed by inspection instead — changes are limited to removing cache directories from the Dockerfiles (reduces, doesn't add, attack surface), CI workflow edits, compose value corrections, and new pure-TS test/script files with no new dependencies, so no impact on scan results is expected.

### Completion Notes List

- All 21 ACs verified or implemented. Regression-only ACs (#1, #3–#10, #12, #13, #15, #16) confirmed against the existing Story 1.1 baseline with no functional changes, except two genuine gaps found during verification (not assumed from the AC text) and fixed:
  1. `pnpm docker:smoke` was not reliably exiting 0 due to a curl retry-flag gap around a brief container-startup race — fixed in `package.json`.
  2. Both Docker images exceeded the 300MB AC #2 limit due to uncleaned pnpm/npm caches in the runner stage — fixed in both Dockerfiles. Final sizes: api 277MB, web 244MB.
- AC #11/#21: CI now builds both `apps/api/Dockerfile` and `apps/web/Dockerfile` for `linux/amd64,linux/arm64` via `docker/build-push-action@v6` with `push: false`, and `docker/setup-buildx-action@v3` explicitly sets `driver: docker-container`. Separate single-platform `load: true` builds back the new image-size check step (multi-platform builds without push can't be loaded into the local Docker daemon for inspection).
- AC #2: Added `scripts/check-image-size.ts` for local/manual use, and an equivalent inline bash step in `.github/workflows/ci.yml`'s `docker-build` job (kept inline in CI to avoid pulling in Node/pnpm setup into a job that otherwise only needs Docker).
- AC #14: Added `apps/api/src/lib/cors.test.ts` with two tests, asserting the actual observed behavior (500 on rejection, not the epic's illustrative 403) per the AC's explicit instruction to verify rather than assume. No `app.ts` changes.
- AC #17/#18: Corrected `docker-compose.prod.yml` mem_limit (db 1g, api 512m, web 256m) and max-file (5) values; added the `vault_keys` reserved-for-Story-1.5 comment.
- AC #19/#20: README production command now includes `-d`; the CI gates table's multi-arch claim is now accurate given AC #11's implementation — no further correction needed.
- Registry push to GHCR remains explicitly out of scope for this story (build-validation only, `push: false`), consistent with the Conflict Resolution Notes — no registry/credentials decision has been made.
- Pre-existing, unrelated working-tree changes (dependency version bumps in various `package.json` files, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, and edits to the Story 1.1 artifact file) were present before this story's work began and are intentionally left untouched and excluded from this story's File List.

### File List

- `.github/workflows/ci.yml` — multi-arch build steps for api+web, `driver: docker-container`, image-size-check step
- `apps/api/Dockerfile` — clean pnpm/npm caches in runner stage to fix 300MB overage
- `apps/web/Dockerfile` — clean pnpm/npm caches in runner stage to fix 300MB overage
- `docker-compose.prod.yml` — corrected mem_limit/max-file values, `vault_keys` comment
- `package.json` — `docker:smoke` script: `--retry-connrefused` → `--retry-all-errors`
- `README.md` — production command `-d` flag
- `scripts/check-image-size.ts` — new, local/manual 300MB image-size check
- `apps/api/src/lib/cors.test.ts` — new, CORS allow/reject test coverage
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — status tracking (in-progress → review)

## Change Log

- 2026-06-24: Implemented Story 1.3. Wired multi-arch (amd64/arm64) CI build validation for both `apps/api` and `apps/web` Dockerfiles; added a 300MB image-size CI gate after discovering both images exceeded the limit due to uncleaned pnpm/npm caches in the runner stage (fixed in both Dockerfiles); added missing CORS allow/reject test coverage; corrected `docker-compose.prod.yml` resource/logging values; fixed a `docker:smoke` retry-flag gap that caused intermittent non-zero exits; documentation accuracy fixes in README. Status: ready-for-dev → review.
