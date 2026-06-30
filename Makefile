SHELL := /usr/bin/env bash

# Project Vault — developer/operator tasks
# Operator quickstart: docs/operator-quickstart.md
#   make bootstrap         — local dev DB setup (Postgres + migrate + RLS)
#   make bootstrap-docker  — full Docker stack
# Pass ARGS to bootstrap targets, e.g. make bootstrap ARGS="--start-api --init-vault"

# --- DB connection strings -----------------------------------------------
# postgres = superuser, only used to run migrations (creates the vault_app
# role, RLS policies, and triggers). vault_app = the app role; using the
# superuser anywhere else bypasses RLS entirely and silently invalidates
# the isolation tests. See .env.example and docs/operator-quickstart.md.
DB_URL_SUPERUSER ?= postgresql://postgres:password@localhost:5432/project_vault
DB_URL_APP        ?= postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault

.PHONY: help install dev build lint typecheck generate-spec jscpd audit \
        db-up db-down db-migrate check-rls test stryker ci \
        bootstrap bootstrap-docker \
        docker-up docker-down docker-down-v docker-build docker-logs docker-smoke docker-prod docker-prod-down \
        clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

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

# --- Tests / quality gates --------------------------------------------------

test: ## Run the test suite (must run as vault_app — postgres bypasses RLS)
	DATABASE_URL=$(DB_URL_APP) ADMIN_DATABASE_URL=$(DB_URL_SUPERUSER) pnpm turbo test --force

stryker: ## Run Stryker mutation testing (matches nightly CI)
	DATABASE_URL=$(DB_URL_SUPERUSER) pnpm stryker run

ci: ## Full local quality gates (needs Postgres: make db-up or make bootstrap first)
	pnpm turbo typecheck
	pnpm turbo lint
	$(MAKE) db-migrate
	$(MAKE) check-rls
	pnpm check-search-index
	$(MAKE) test
	pnpm jscpd
	pnpm tsx scripts/check-audit-baseline.ts
	pnpm tsx scripts/check-env-example.ts
	pnpm audit --audit-level=high
	pnpm generate-spec
	git diff --exit-code packages/shared/openapi.json

# --- Docker -----------------------------------------------------------------

docker-up: ## Build and start the full stack (db, migrate, api, web)
	docker compose up --build -d

docker-down: ## Stop the full stack
	docker compose down

docker-down-v: ## Stop the full stack and delete volumes (destroys db data)
	docker compose down -v

docker-build: ## Build the api and web images without starting containers
	docker compose build

docker-logs: ## Follow logs for the full stack
	docker compose logs -f

docker-smoke: ## Build, start, and curl /health + /ready end-to-end
	pnpm docker:smoke

docker-prod: ## Start the stack with production overrides
	docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

docker-prod-down: ## Stop the production stack
	docker compose -f docker-compose.yml -f docker-compose.prod.yml down

# --- Cleanup -----------------------------------------------------------------

clean: ## Remove build artifacts and turbo cache (does not touch node_modules or docker volumes)
	rm -rf .turbo apps/*/dist packages/*/dist apps/*/.turbo packages/*/.turbo
