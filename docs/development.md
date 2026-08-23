# Development guide

## Docker port isolation

Each checkout keeps its own `.env`, and Docker Compose publishes the database, API, and web ports
from `DB_HOST_PORT`, `API_HOST_PORT`, and `WEB_HOST_PORT`. Before a bare Docker Compose command:

```bash
make check-ports
make fix-ports # only when a configured port is busy
```

`make docker-up`, `make docker-smoke`, and `make bootstrap-docker` perform the port repair
automatically. The container and volume names are already isolated by the Compose project name;
the host ports are the shared resource that needs checking.

## Local quality gates

`make ci` runs the public build, typecheck, lint, migration, RLS, security, test, duplication, and
generated-spec freshness checks inside the CI Docker service. It does not require private planning or
BMAD artifacts. Private story and sprint governance checks live in the companion
`project-vault-private` repository.

Run focused package tests while developing, then run `make ci` once after the complete change set
is ready.

## Manual QA against a live dev stack (with a mock extension loaded)

For a Chrome/browser-driven manual check against real running servers — e.g. to exercise a
capability-gated UI control in both its granted and denied states — the following recipe is
known to work in a fresh git worktree with no prior local setup:

1. **Find (or create) this worktree's own isolated Docker Compose project.** Every worktree that
   has run `make docker-up`/`make bootstrap-docker` at least once gets its own Compose project
   (named after the worktree directory) with its own `db` container on its own host port —
   separate from the main checkout's. Check what's already running and its port:
   ```bash
   docker compose ls
   docker compose -p <worktree-dir-name> ps --format "{{.Name}}\t{{.Ports}}"
   ```
   If none exists yet for this worktree, `make docker-up` creates one.

2. **Apply migrations against that isolated DB** (safe to re-run; a no-op if already current):
   ```bash
   DATABASE_URL="postgresql://postgres:password@localhost:<db-port>/project_vault" pnpm db:migrate
   ```

3. **If `ADMIN_DATABASE_URL could not reach the configured role` on API boot**, the `vault_admin`/
   `vault_app` role passwords in that container haven't been provisioned to the values the app
   expects (this happens on a DB volume that was migrated directly rather than brought up via the
   full `docker-up`/`operator-bootstrap.sh` flow, which normally sets these). Fix once per
   container:
   ```bash
   docker exec <worktree-dir-name>-db-1 psql -U postgres -d project_vault \
     -c "ALTER ROLE vault_admin PASSWORD 'password';"
   docker exec <worktree-dir-name>-db-1 psql -U postgres -d project_vault \
     -c "ALTER ROLE vault_app PASSWORD 'dev-only-change-in-prod';"
   ```

4. **Start the dev servers** with the DB pointed at that port, and (optionally) a mock extension
   loaded — `VAULT_EXTENSIONS_PACKAGE` is passed through by `turbo.json`'s `globalPassThroughEnv`,
   so it reaches `apps/api`'s `tsx watch` process started via `pnpm turbo dev`:
   ```bash
   DATABASE_URL="postgresql://vault_app:dev-only-change-in-prod@localhost:<db-port>/project_vault" \
   ADMIN_DATABASE_URL="postgresql://vault_admin:password@localhost:<db-port>/project_vault" \
   VAULT_EXTENSIONS_PACKAGE="@project-vault/mock-capability-gate-extension" \
   VAULT_ALLOW_REMOTE_INIT="true" \
   pnpm turbo dev
   ```
   `VAULT_ALLOW_REMOTE_INIT=true` skips the bootstrap-token requirement for vault init (dev-only
   escape hatch, see `apps/api/src/modules/vault/key-service.ts`) — do not set it outside a
   throwaway local check. Confirm both servers are up: API prints `"API startup complete"`, web
   prints `Local: http://localhost:5173/`. Confirm the mock extension actually loaded via
   `curl -s http://localhost:3000/health` — `extensions_status` should read `"loaded"`, not
   `"not_configured"`.

5. **Initialize the vault directly via API** (skips the init-form UI entirely, useful when
   automating this or when the form is inconvenient to drive by hand):
   ```bash
   curl -s -X POST http://localhost:3000/api/v1/vault/init -H "Content-Type: application/json" \
     -d '{"kmsType":"passphrase","passphrase":"<any-string-at-least-12-chars>"}'
   ```

6. **Register a test user, org, and project** through the normal `/register` UI flow, then
   navigate to the feature under test.

`mock-capability-gate-extension`'s default behavior (`fixtures/mock-capability-gate-extension/src/index.ts`):
every org id is **denied** the `monitoring.public-status-page` capability except the two literal
fixture ids (`fixture-org-permitted`, `fixture-org-upgraded`) — a freshly-registered real org is
denied by default. To simulate the granted state for a real org without editing the fixture, set
`MOCK_CAPABILITY_GATE_EXTRA_PERMITTED_ORG_ID=<real-org-uuid>` before starting the API and restart
(the fixture reads this once at module load — see the file's own doc comment on that variable).

## CodeQL language coverage

The public repository's CodeQL default setup scans GitHub Actions and JavaScript/TypeScript. Private
BMAD tooling is maintained in the companion private repository, so Python is intentionally not part
of the public CodeQL language set. Update the repository CodeQL default-setup configuration whenever
the public language footprint changes.
