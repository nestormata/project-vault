SHELL := /usr/bin/env bash

# Project Vault — developer/operator tasks
# Operator quickstart: docs/operator-quickstart.md
#   make bootstrap         — local dev DB setup (Postgres + migrate + RLS)
#   make bootstrap-docker  — full Docker stack
# Pass ARGS to bootstrap targets, e.g. make bootstrap ARGS="--start-api --init-vault"
# (`make bootstrap -- --init-vault` does NOT work — make treats --init-vault as a goal.)
#
# Host ports are per-checkout: every target below that touches Docker runs
# scripts/docker-ports.sh fix, which rewrites DB/API/WEB_HOST_PORT in .env away from
# 5432/3000/5173. Set DOCKER_PORTS_KEEP_DEFAULTS=1 to keep the classic ports on a single
# checkout. See docs/operator-quickstart.md "Ports and URLs".

# --- Host ports (multiple worktrees / standalone test stacks) --------------
# Read from .env so `make db-migrate`/etc. talk to the same host port
# docker-compose.yml actually published (which may have been bumped by
# `make fix-ports` to dodge a conflict). Override on the command line, e.g.
# `make db-migrate DB_HOST_PORT=5433`. See docs/development.md "Docker port isolation".
#
# Fallback chain (first one already set wins): env var (e.g. docker-compose.ci.yml sets
# DB_HOST_PORT=5432 for the `ci` service — that's Postgres's fixed *in-container* port, unrelated
# to whatever the host publishes) -> .env -> a value derived from this worktree's own absolute
# path. The derived fallback matters because it's what a *missing* .env falls back to — a fresh
# worktree, or one whose .env was deleted/regenerated, used to silently revert to the literal 5432
# every worktree starts with, which is exactly the collision this whole scheme exists to prevent.
# scripts/docker-ports.sh derives the same value the same way, so the two never disagree.
ifeq ($(strip $(DB_HOST_PORT)),)
DB_HOST_PORT := $(shell grep -m1 '^DB_HOST_PORT=' .env 2>/dev/null | cut -d= -f2)
endif
ifeq ($(strip $(DB_HOST_PORT)),)
DB_HOST_PORT := $(shell echo $$(( 20000 + $$(printf '%s' "$(CURDIR)" | cksum | cut -d' ' -f1) % 10000 )) )
endif

# --- DB connection host ---------------------------------------------------
# localhost by default (bare-host `make test`/`make db-migrate`/etc. against a docker-up'd or
# bootstrapped stack). docker-compose.ci.yml overrides this to `db` for the `ci` service, so the
# exact same targets below resolve to the container-internal Compose network instead — see
# Makefile's `ci`/`ci-inner` targets and docs/development.md "Local quality gates".
DB_CONN_HOST ?= localhost
BASE_REF ?= main

# --- DB connection strings -----------------------------------------------
# postgres = superuser, only used to run migrations (creates the vault_app
# role, RLS policies, and triggers). vault_app = the app role; using the
# superuser anywhere else bypasses RLS entirely and silently invalidates
# the isolation tests. See .env.example and docs/operator-quickstart.md.
DB_URL_SUPERUSER ?= postgresql://postgres:password@$(DB_CONN_HOST):$(DB_HOST_PORT)/project_vault
DB_URL_APP        ?= postgresql://vault_app:dev-only-change-in-prod@$(DB_CONN_HOST):$(DB_HOST_PORT)/project_vault
DB_URL_ADMIN      ?= postgresql://vault_admin:password@$(DB_CONN_HOST):$(DB_HOST_PORT)/project_vault

.PHONY: help install dev build lint typecheck generate-spec jscpd audit sonar-issues check-public-safety check-form-guidance check-function-executability check-function-executability-tests \
        db-up db-down db-migrate check-rls test test-repeat stryker ci ci-inner web-host-fixture composition-kit-integration mock-ui-pack-compose mock-ui-pack-e2e \
        check-extension-api-policy check-extension-api-policy-content check-extension-api-behaviour check-extension-api-markers check-extension-api-contract-changelog \
        bootstrap bootstrap-docker check-ports fix-ports \
        docker-up docker-down docker-down-v docker-build docker-logs docker-smoke docker-backup-permission-smoke docker-prod docker-prod-down \
        e2e \
        clean

# Story 10-1: target-name class widened to include digits (was [a-zA-Z_-]) so the new `e2e`
# target (name required by AC-I6) actually appears in this listing — every prior target name
# happened to be all-letters/hyphens, so this gap was latent until now.
help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

# --- Setup / dev ----------------------------------------------------------

install: ## Install dependencies
	pnpm install

dev: ## Start all dev servers (turbo dev)
	pnpm turbo dev

build: ## Build all packages/apps
	pnpm turbo build

lint: ## Lint all packages/apps
	pnpm turbo lint

typecheck: ## Typecheck all packages/apps
	pnpm turbo typecheck

generate-spec: ## Regenerate the OpenAPI spec
	pnpm generate-spec

jscpd: ## Check for duplicate code
	pnpm jscpd

audit: ## Audit dependencies for high/critical CVEs
	pnpm audit --audit-level=high

sonar-issues: ## List open SonarCloud issues (needs SONAR_TOKEN/SONAR_ORGANIZATION/SONAR_PROJECT_KEY in .env; see docs/sonarqube.md)
	./scripts/sonar-issues.sh

check-public-safety: ## Review changed/untracked content for publication risks (BASE_REF=main; strict blocks all findings)
	BASE_REF=$(BASE_REF) pnpm check-public-safety -- --base "$(BASE_REF)" --strict

check-form-guidance: ## Verify every user-facing web form control has localized accessible help
	pnpm check-form-guidance

# --- Operator bootstrap (Epic 1 retro D2) ------------------------------------

bootstrap: ## Postgres + migrate + vault_admin credential + RLS check (docs/operator-quickstart.md); ARGS e.g. --start-api --init-vault
	./scripts/operator-bootstrap.sh $(ARGS)

bootstrap-docker: ## Full docker compose up; ARGS e.g. --init-vault (needs jq + VAULT_DEV_PASSPHRASE)
	./scripts/operator-bootstrap.sh --docker $(ARGS)

# --- Database --------------------------------------------------------------
# Requires Postgres on localhost:$(DB_HOST_PORT) — start it with `make bootstrap`, `make db-up`,
# or `make docker-up`. Note `make db-up` alone does NOT provision the vault_admin credential that
# ADMIN_DATABASE_URL/`make test` need; `make bootstrap` and `make docker-up` do.

db-up: ## Start only the Postgres container
	docker compose up -d db

db-down: ## Stop the Postgres container
	docker compose stop db

db-migrate: ## Run migrations as the postgres superuser (creates vault_app role + RLS)
	DATABASE_URL=$(DB_URL_SUPERUSER) pnpm db:migrate

check-rls: ## Verify every table has RLS policy coverage (must run as vault_app)
	DATABASE_URL=$(DB_URL_APP) pnpm check-rls

check-function-executability: ## Verify no in-scope public function is PUBLIC-executable (Story 24.5b)
	DATABASE_URL=$(DB_URL_APP) pnpm check-function-executability

check-function-executability-tests: ## Run the focused Story 24.5b invariant and SQL-twin tests
	DATABASE_URL=$(DB_URL_APP) SUPERUSER_DATABASE_URL=$(DB_URL_SUPERUSER) pnpm vitest run --no-file-parallelism packages/db/src/function-executability.test.ts scripts/check-function-executability.test.ts

check-audit-actor-token-coverage: ## Verify no human-actor audit row lacks actor_token_id (database-wide gate — must run as superuser to bypass per-org RLS, see Story 8.1 AC-14)
	DATABASE_URL=$(DB_URL_SUPERUSER) pnpm check-audit-actor-token-coverage

# --- Tests / quality gates --------------------------------------------------

test: ## Run the test suite (must run as vault_app — postgres bypasses RLS)
	DATABASE_URL=$(DB_URL_APP) ADMIN_DATABASE_URL=$(DB_URL_ADMIN) SUPERUSER_DATABASE_URL=$(DB_URL_SUPERUSER) pnpm turbo test --force

# N repeat runs turns a rare, timing-dependent flake (e.g. one bad run in ~6-8) into a run
# that fails almost every time, so it surfaces locally/in nightly CI instead of silently
# landing on main. A single green `make test` says nothing about a bug that only shows up
# 1 run in 6 — see the mfa-login.test.ts / mfa-enrollment.test.ts cross-file flake found
# while investigating story 3-4's CI-only failures.
N ?= 5
test-repeat: ## Run the test suite N times back-to-back, stopping at the first failure (make test-repeat N=10)
	for i in $$(seq 1 $(N)); do \
		echo "=== test-repeat: run $$i/$(N) ==="; \
		DATABASE_URL=$(DB_URL_APP) ADMIN_DATABASE_URL=$(DB_URL_ADMIN) SUPERUSER_DATABASE_URL=$(DB_URL_SUPERUSER) pnpm turbo test --force || exit 1; \
	done

# Story 66-7: the nightly runs one leg per shard (api, db; stryker.config.mjs SHARDS). Locally, SHARD=api|db
# runs one leg; the default runs both legs sequentially, each with its own dry run.
STRYKER_SHARDS := $(if $(SHARD),$(SHARD),api db)
stryker: ## Run Stryker mutation testing (matches nightly CI; SHARD=api|db for one leg)
	for shard in $(STRYKER_SHARDS); do \
		STRYKER_SHARD=$$shard DATABASE_URL=$(DB_URL_APP) ADMIN_DATABASE_URL=$(DB_URL_ADMIN) SUPERUSER_DATABASE_URL=$(DB_URL_SUPERUSER) pnpm stryker run || exit 1; \
	done

# Story 43.11 AC-11: the private overlay's repo root, or empty when it is not attached/resolvable.
PRIVATE_OVERLAY_ROOT := $(shell t=$$(readlink -f _bmad-output/implementation-artifacts/sprint-status.yaml 2>/dev/null) && [ -f "$$t" ] && git -C "$$(dirname "$$t")" rev-parse --show-toplevel 2>/dev/null)

ci: ## Full local quality gates — runs inside Docker (isolated per-worktree; see docs/development.md)
	$(MAKE) fix-ports
	@echo "make ci: $(if $(PRIVATE_OVERLAY_ROOT),private overlay mounted read-only from $(PRIVATE_OVERLAY_ROOT),private overlay not found; overlay guards will print SKIPPED)"
	GIT_COMMON_DIR=$$(git rev-parse --path-format=absolute --git-common-dir) \
		PRIVATE_OVERLAY_ROOT='$(PRIVATE_OVERLAY_ROOT)' \
		docker compose -f docker-compose.yml -f docker-compose.ci.yml $(if $(PRIVATE_OVERLAY_ROOT),-f docker-compose.ci-overlay.yml) run --rm --build ci make ci-inner
	# Story 9.9 AC-6/Product Surface Contract G3: runs on the HOST (not inside ci-inner's
	# container, which has no Docker socket to build/run nested images from) — builds the real
	# apps/api image and exercises docker-entrypoint.sh's backup-volume chown-then-drop-privileges
	# behavior end-to-end, both the fresh-named-volume and unfixable-bind-mount cases.
	$(MAKE) docker-backup-permission-smoke
	# Story 60.7: runs on the HOST; the ci container has no Docker CLI, so inside ci-inner this
	# suite would only print SKIPPED. Needs host `pnpm install`. Renders with its own --env-file,
	# so the local config fix-ports just touched cannot affect it.
	pnpm vitest run scripts/check-compose-config.test.ts

ci-inner: ## The actual CI steps — only meant to run inside the `ci` container (make ci), not directly
	DATABASE_URL=$(DB_URL_APP) ADMIN_DATABASE_URL=$(DB_URL_ADMIN) pnpm turbo typecheck
	pnpm turbo lint
	$(MAKE) db-migrate
	# docker-compose.ci.yml's `ci` service only depends on `db` (service_healthy) — it never
	# brings up the `admin-provision` service that ALTER ROLEs vault_admin's password for
	# `make docker-up`, so migration 0071's freshly-created vault_admin role is left with no
	# usable password here. Without this, every ADMIN_DATABASE_URL-backed query (e.g.
	# findErasedRequestForEmailGlobally at registration) fails with "password authentication
	# failed for user \"vault_admin\"", cascading into hundreds of unrelated test failures.
	# Mirrors .github/workflows/ci.yml's "Provision local test admin role credential" step.
	psql "$(DB_URL_SUPERUSER)" -v ON_ERROR_STOP=1 -c "ALTER ROLE vault_admin PASSWORD 'password'"
	$(MAKE) check-rls
	$(MAKE) check-function-executability
	$(MAKE) check-function-executability-tests
	$(MAKE) check-audit-actor-token-coverage
	pnpm check-search-index
	pnpm check-migration-compatibility
	pnpm check-story-status-sync
	pnpm check-sprint-status-rollup
	# Story 43.11 AC-4/AC-6: duplicate DW-ID guard over the private overlay's deferred-work.md.
	pnpm check-deferred-work-ids
	# Story 43.12 AC-5/AC-7: every open DW entry names a revisit trigger (epic-59 retro Finding 4).
	pnpm check-deferred-work-triggers
	# Story 43.12 AC-1..AC-4/AC-7: done stories' review trade-offs are ledgered (epic-43 retro Finding 1).
	pnpm check-review-tradeoff-ledger
	# Story 43.11 AC-6.4: the story-integrity guards' own tests; --dir scripts keeps vitest's
	# substring filters from also matching stale copies in nested agent worktrees.
	pnpm vitest run --dir scripts check-sprint-status-rollup.test.ts check-story-status-sync.test.ts check-deferred-work-ids.test.ts next-dw-id.test.ts lib/deferred-work-ledger.test.ts check-ci-story-integrity-wiring.test.ts check-review-tradeoff-ledger.test.ts check-review-tradeoff-ledger-sections.test.ts check-deferred-work-triggers.test.ts
	pnpm check-story-references
	pnpm check-psc-tbd-tracking
	pnpm check-story-review-deferrals
	pnpm check-alert-pending-epic3
	pnpm check-followup-review-gate
	pnpm check-epic-gate
	pnpm check-epic-retro-freshness
	pnpm check-implementation-artifacts-symlinks
	$(MAKE) check-form-guidance
	pnpm check-public-safety -- --base main --strict
	pnpm check-extension-api-policy
	pnpm check-extension-api-policy-content
	pnpm check-extension-api-behaviour
	pnpm check-extension-api-markers
	pnpm check-extension-api-contract-changelog
	pnpm check-extension-api-version-skew
	pnpm vitest run scripts/check-policy-doc-structure.test.ts scripts/check-policy-doc-content.test.ts scripts/check-extension-api-behaviour.test.ts scripts/check-extension-api-markers.test.ts scripts/check-extension-api-contract-changelog.test.ts
	pnpm vitest run scripts/check-extension-api-version-skew.test.ts
	pnpm check-extension-api-license # extension-api and composition-kit are MIT; the repository root stays AGPL-3.0-or-later
	pnpm vitest run scripts/check-extension-api-license.test.ts
	pnpm check-composition-kit-boundary # Story 68.3: the MIT kit imports no AGPL code and has permissive dependencies only
	pnpm vitest run scripts/check-composition-kit-boundary.test.ts
	@# Story 68.4: every PV route file exposes the standard injection points
	pnpm check-injection-point-coverage
	pnpm vitest run scripts/check-injection-point-coverage.test.ts
	@# Story 68.10: every @region block is a component or contains one (replaceable through M4)
	pnpm check-monolithic-regions
	pnpm vitest run scripts/check-monolithic-regions.test.ts scripts/lib/route-files.test.ts
	@# Story 68.10: the mechanism e2e job wiring, its path filter and the mechanism specs cannot pass vacuously
	pnpm vitest run scripts/check-mock-ui-pack-e2e-wiring.test.ts scripts/lib/web-host/consumer-tarballs.test.ts scripts/mock-ui-pack-seed.test.ts scripts/check-pv-nav-snapshot.test.ts scripts/check-mock-ui-pack-not-in-production.test.ts
	@# Story 68.7: every PV nav item has a stable id; every nav surface is rendered from nav data
	pnpm check-nav-ids
	pnpm vitest run scripts/check-nav-ids.test.ts
	pnpm check-nav-surfaces
	pnpm vitest run scripts/check-nav-surfaces.test.ts
	pnpm vitest run scripts/extension-authoring-docs.test.ts # Story 59.2 AC-3 authoring-doc drift guard
	pnpm check-native-credential-surface
	pnpm check-no-sonar-suppressions # Story 43.9 AC-9: no unsigned Sonar suppressions
	pnpm vitest run scripts/check-no-sonar-suppressions.test.ts scripts/lib/trusted-executable.test.ts
	pnpm vitest run scripts/check-stryker-config.test.ts # Story 66-7: Stryker shard/threshold/vitest-5 patch invariants
	pnpm vitest run scripts/check-nightly-workflow.test.ts # Story 66-11: nightly quiet-day gate + 5-leg flaky repeat matrix
	# Story 43.16 AC-3/AC-5: Fly demo internal TLS — PKI script, fly-setup wiring, pinned-CA call sites.
	# Story 43.28: + Fly workflow contract (bootstrap order, concurrency, release pnpm) and fly-ensure-started.sh.
	pnpm vitest run scripts/fly-setup.test.ts scripts/fly-internal-tls.test.ts scripts/check-pg-tls-call-sites.test.ts scripts/check-fly-deploy-workflow.test.ts scripts/fly-ensure-started.test.ts
	pnpm check-build-info-unstamped # Story 43.6 AC-5
	# Story 43.14: the CLI docs guard raw-loads an apps/web .ts file, whose tsconfig extends the
	# generated .svelte-kit/tsconfig.json. A turbo cache hit on typecheck above does not regenerate it.
	pnpm --filter @project-vault/web-host exec svelte-kit sync
	pnpm vitest run scripts/check-build-info-unstamped.test.ts scripts/stamp-build-info.test.ts scripts/check-cli-release-workflow.test.ts scripts/check-cli-docs-naming.test.ts
	pnpm check-audit-insert-sites
	$(MAKE) test
	pnpm jscpd
	pnpm tsx scripts/check-audit-baseline.ts
	pnpm vitest run scripts/check-audit-baseline.test.ts
	pnpm check-crypto-adjacent-pins # Story 42.3 pin/grouping gate + Story 42.5 CODEOWNERS sync gate
	pnpm vitest run scripts/check-crypto-adjacent-pins.test.ts
	pnpm vitest run scripts/check-base-image-digest.test.ts # Story 64.1 AC-2 base digest lockstep guard
	pnpm vitest run scripts/check-base-image-refresh-workflow.test.ts # Story 64.4 base-image refresh workflow contract
	pnpm vitest run scripts/check-action-pins.test.ts # Story 64.2 AC-3 third-party action SHA-pin guard
	pnpm vitest run scripts/check-container-publish-workflow.test.ts scripts/check-image-scan-workflows.test.ts # Story 64.3 AC-5 image-scan gate contracts
	pnpm vitest run scripts/e2e-stack.test.ts # Story 66.1 AC-7 e2e stack script contract
	pnpm vitest run scripts/check-web-svelte-check-wiring.test.ts # Story 68.1 AC-4 svelte-check gate wiring
	# Story 68.2 AC-1: no pnpm override may make a declared dependency range false.
	pnpm vitest run scripts/check-no-false-overrides.test.ts
	# Story 68.2: web-host pack gates (paraglide pin, pack libraries, tarball rules, release workflow
	# contract). The slow out-of-monorepo consumer fixture is `make web-host-fixture`.
	pnpm vitest run scripts/check-paraglide-plugin-pinned.test.ts scripts/lib/web-host scripts/lib/version-triangle.test.ts
	pnpm vitest run scripts/check-web-host-tarball.test.ts
	@# Story 68.10 AC-9: PV's own CM-free build is the control group (empty virtual modules, main response snapshot)
	pnpm turbo build --force --filter=@project-vault/web-host
	pnpm vitest run scripts/check-pv-cm-free-build.test.ts
	pnpm vitest run scripts/check-web-host-release-workflow.test.ts
	# Story 68.12 AC-5: the npm release verification helper's unit test (no network).
	pnpm vitest run scripts/verify-npm-release.test.ts
	# Story 68.3: the kit's release version triangle and the integration job's wiring (the slow
	# integration itself is `make composition-kit-integration`).
	pnpm vitest run scripts/check-release-version-triangle.test.ts scripts/check-composition-kit-integration.test.ts
	# Story 68.9: PV's web guards over a composed tree (guard completeness and symmetry, this wiring, the
	# shipped form-guidance scanner). The registry builders run above (scripts/lib/web-host); pv-verify's
	# own tests run with the kit's tests.
	pnpm vitest run scripts/check-web-guard-completeness.test.ts scripts/check-web-guard-symmetry.test.ts scripts/check-web-guard-wiring.test.ts scripts/check-form-guidance.test.ts
	pnpm tsx scripts/check-env-example.ts
	# Blocking, matching ci.yml's `audit-ci` step on this same command (Story 42.2 — the
	# formerly non-blocking `pnpm audit --audit-level=high || true` is superseded by this
	# schema-correct, high-or-above-only audit-ci invocation; see audit-ci.jsonc and
	# scripts/check-audit-baseline.ts for the config shape and hygiene checks). The
	# undici advisory formerly accepted here via packages/vault-action's @actions/core
	# dependency is resolved (undici@7.29.0, no advisory as of Story 42.1, 2026-09-19); run
	# `pnpm exec audit-ci --config audit-ci.jsonc` for the current high-or-above inventory.
	pnpm exec audit-ci --config audit-ci.jsonc
	DATABASE_URL=$(DB_URL_APP) ADMIN_DATABASE_URL=$(DB_URL_ADMIN) pnpm generate-spec
	git diff --exit-code packages/shared/openapi.json

composition-kit-integration: ## Story 68.3 AC-12: compose a mini UI pack onto the packed web-host in an isolated consumer, then check, build, boot and serve it (slow, needs the npm registry)
	COMPOSITION_KIT_INTEGRATION=1 pnpm vitest run scripts/check-composition-kit-integration.test.ts

mock-ui-pack-e2e: ## Story 68.10: compose the mock UI pack, build the composed web image, boot it with a real API and database and run the M1-M7 mechanism e2e (host-side: needs Docker and the npm registry; `make mock-ui-pack-e2e SPEC=e2e/mechanism/m7-api-routes.spec.ts`, no `--`)
	pnpm tsx scripts/mock-ui-pack-e2e.ts $(SPEC)

mock-ui-pack-compose: ## Story 68.10 AC-2.1: compose the mock UI pack onto the packed web-host, run pv-compose --check, pv-verify guards, svelte-check, the build and HTTP/CSS checks (slow, needs the npm registry)
	MOCK_UI_PACK_COMPOSE=1 pnpm vitest run scripts/check-mock-ui-pack-compose.test.ts

web-host-fixture: ## Story 68.2 AC-8: pack web-host and build/boot an out-of-monorepo consumer from the tarball (slow, needs the npm registry)
	WEB_HOST_FIXTURE=1 pnpm vitest run scripts/check-web-host-consumer-fixture.test.ts

# --- Docker -----------------------------------------------------------------

check-ports: ## Check DB/API/WEB host ports are free (fails with a hint if not; see docs/development.md)
	./scripts/docker-ports.sh check

fix-ports: ## Auto-bump any busy DB/API/WEB host port to the next free one and write .env
	./scripts/docker-ports.sh fix

docker-up: fix-ports ## Build and start the full stack (db, migrate, api, web)
	docker compose up --build -d

docker-down: ## Stop the full stack
	docker compose down

docker-down-v: ## Stop the full stack and delete volumes (destroys db data)
	docker compose down -v

docker-build: ## Build the api and web images without starting containers
	docker compose build

docker-logs: ## Follow logs for the full stack
	docker compose logs -f

# Story 10-1: e2e deliberately does NOT depend on plain `docker-up` — that starts the base
# docker-compose.yml stack, whose `api` service must never default to VAULT_ALLOW_REMOTE_INIT=true
# (that would silently weaken every developer's default local bootstrap-token protection). Instead
# this applies docker-compose.e2e.yml's override on top, scoped to this target only, matching
# nightly.yml's `e2e` job's own compose invocation (see docker-compose.e2e.yml's own comment).
#
# fix-ports only writes bumped ports into .env for docker-compose's own auto-load — it does not
# export them into this shell. playwright.config.ts/global-setup.ts/fixtures/db.ts all read
# DB_HOST_PORT/API_HOST_PORT/WEB_HOST_PORT straight from process.env (no dotenv loading), so this
# recipe must re-read .env and export them itself before invoking pnpm, mirroring
# scripts/docker-smoke.sh's own precedent for the same problem — otherwise a worktree whose ports
# were actually bumped would run Playwright against the wrong (default) ports while docker-compose
# itself listens on the bumped ones, producing a misleading "did you run `make docker-up`?" failure.
#
# Story 66.1: the stack is started by scripts/e2e-stack.sh (the same script nightly.yml's e2e job
# uses), run as a CHILD process so its per-run throwaway secrets die with it and never reach this
# shell or Playwright. SPEC is appended to test:e2e with NO `--` (pnpm forwards extra args as-is; a
# literal `--` makes Playwright ignore the filter and run every journey). Paths only, e.g.
# `make e2e SPEC=e2e/journeys/j28-handoff-confirmation.spec.ts`.
e2e: fix-ports ## Playwright E2E suite against a real docker-compose stack: make e2e [SPEC=e2e/journeys/<file>]
	./scripts/e2e-stack.sh start
	@DB_HOST_PORT="$$(grep -m1 '^DB_HOST_PORT=' .env 2>/dev/null | cut -d= -f2)"; \
	API_HOST_PORT="$$(grep -m1 '^API_HOST_PORT=' .env 2>/dev/null | cut -d= -f2)"; \
	WEB_HOST_PORT="$$(grep -m1 '^WEB_HOST_PORT=' .env 2>/dev/null | cut -d= -f2)"; \
	E2E_CONFIRM_DB_RESET=true; \
	export DB_HOST_PORT API_HOST_PORT WEB_HOST_PORT E2E_CONFIRM_DB_RESET; \
	pnpm --filter @project-vault/web-host exec playwright install --with-deps chromium && \
	pnpm --filter @project-vault/web-host test:e2e $(if $(SPEC),"$(SPEC)")

docker-smoke: fix-ports ## Build, start, and curl /health + /ready end-to-end
	pnpm docker:smoke

docker-backup-permission-smoke: ## Story 9.9 AC-6: verify docker-entrypoint.sh's backup volume chown-then-drop-privileges behavior against the real built image
	./scripts/backup-permission-smoke.sh

docker-prod: ## Start the stack with production overrides
	docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

docker-prod-down: ## Stop the production stack
	docker compose -f docker-compose.yml -f docker-compose.prod.yml down

# --- Cleanup -----------------------------------------------------------------

clean: ## Remove build artifacts and turbo cache (does not touch node_modules or docker volumes)
	rm -rf .turbo apps/*/dist packages/*/dist apps/*/.turbo packages/*/.turbo
