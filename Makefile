SHELL := /usr/bin/env bash

# Project Vault — developer/operator tasks
# Operator quickstart: docs/operator-quickstart.md
#   make bootstrap         — local dev DB setup (Postgres + migrate + RLS)
#   make bootstrap-docker  — full Docker stack
# Pass ARGS to bootstrap targets, e.g. make bootstrap ARGS="--start-api --init-vault"

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
        db-up db-down db-migrate check-rls test test-repeat stryker ci ci-inner \
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

bootstrap: ## Postgres + migrate + RLS check (see docs/operator-quickstart.md); ARGS e.g. --start-api --init-vault
	./scripts/operator-bootstrap.sh $(ARGS)

bootstrap-docker: ## Full docker compose up; ARGS e.g. --init-vault (needs jq + VAULT_DEV_PASSPHRASE)
	./scripts/operator-bootstrap.sh --docker $(ARGS)

# --- Database --------------------------------------------------------------
# Requires Postgres on localhost:5432 — `make bootstrap`, `make db-up`, or `make docker-up`.

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

stryker: ## Run Stryker mutation testing (matches nightly CI)
	DATABASE_URL=$(DB_URL_APP) ADMIN_DATABASE_URL=$(DB_URL_ADMIN) SUPERUSER_DATABASE_URL=$(DB_URL_SUPERUSER) pnpm stryker run

ci: ## Full local quality gates — runs inside Docker (isolated per-worktree; see docs/development.md)
	$(MAKE) fix-ports
	GIT_COMMON_DIR=$$(git rev-parse --path-format=absolute --git-common-dir) \
		docker compose -f docker-compose.yml -f docker-compose.ci.yml run --rm --build ci make ci-inner
	# Story 9.9 AC-6/Product Surface Contract G3: runs on the HOST (not inside ci-inner's
	# container, which has no Docker socket to build/run nested images from) — builds the real
	# apps/api image and exercises docker-entrypoint.sh's backup-volume chown-then-drop-privileges
	# behavior end-to-end, both the fresh-named-volume and unfixable-bind-mount cases.
	$(MAKE) docker-backup-permission-smoke

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
	pnpm check-story-references
	pnpm check-psc-tbd-tracking
	pnpm check-story-review-deferrals
	pnpm check-alert-pending-epic3
	pnpm check-followup-review-gate
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
	pnpm check-native-credential-surface
	pnpm check-audit-insert-sites
	$(MAKE) test
	pnpm jscpd
	pnpm tsx scripts/check-audit-baseline.ts
	pnpm tsx scripts/check-env-example.ts
	# Non-blocking, matching ci.yml's `continue-on-error: true` on this same command — see
	# packages/vault-action's accepted transitive undici advisory via @actions/core.
	pnpm audit --audit-level=high || true
	DATABASE_URL=$(DB_URL_APP) ADMIN_DATABASE_URL=$(DB_URL_ADMIN) pnpm generate-spec
	git diff --exit-code packages/shared/openapi.json

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
e2e: fix-ports ## Playwright E2E suite against a real docker-compose stack (installs Chromium on first run)
	docker compose -f docker-compose.yml -f docker-compose.e2e.yml up --build -d
	@DB_HOST_PORT="$$(grep -m1 '^DB_HOST_PORT=' .env 2>/dev/null | cut -d= -f2)"; \
	API_HOST_PORT="$$(grep -m1 '^API_HOST_PORT=' .env 2>/dev/null | cut -d= -f2)"; \
	WEB_HOST_PORT="$$(grep -m1 '^WEB_HOST_PORT=' .env 2>/dev/null | cut -d= -f2)"; \
	E2E_CONFIRM_DB_RESET=true; \
	export DB_HOST_PORT API_HOST_PORT WEB_HOST_PORT E2E_CONFIRM_DB_RESET; \
	pnpm --filter @project-vault/web exec playwright install --with-deps chromium && \
	pnpm --filter @project-vault/web test:e2e

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
