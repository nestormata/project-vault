# Development guide

## Docker port isolation

Each checkout keeps its own `.env`, and Docker Compose publishes the database, API, and web ports
from `DB_HOST_PORT`, `API_HOST_PORT`, and `WEB_HOST_PORT`. Before a bare Docker Compose command:

```bash
make check-ports
make fix-ports # only when a configured port is busy
```

`make bootstrap`, `make bootstrap-docker`, `make docker-up`, `make docker-smoke` and `make e2e`
perform the port repair automatically. The container and volume names are already isolated by the
Compose project name; the host ports are the shared resource that needs checking.

Note that `fix` does more than resolve live conflicts: any of the three keys still sitting at the
shared default (5432/3000/5173) is migrated to a value derived from this checkout's path **even
when the port is free**, so two worktrees never start out sharing a default. Read the values back
with `grep -E '^(DB|API|WEB)_HOST_PORT=' .env` and build every `localhost:<port>` URL from them.

**Opt-out for a single checkout.** Export `DOCKER_PORTS_KEEP_DEFAULTS=1` and the script keeps
5432/3000/5173 (and restores them if an earlier run already isolated this checkout). Ports that
are genuinely in use are still moved, and the script prints
`FIXED …(was already in use)` when that happens. Do not set it when running several worktrees
concurrently.

## Compose overlays

The base stack is `docker-compose.yml` (`db`, `migrate`, `admin-provision`, `api`, `web`,
`mailpit`). Overlays are layered with additional `-f` flags, and order matters — Compose merges
`environment:` key-by-key with the last file winning.

| Overlay | Applied by | What it does |
|---|---|---|
| `docker-compose.dev.yml` | manual | Bind-mounts `apps/*/src`, runs the API with `pnpm dev` (hot reload) and sets `VAULT_ALLOW_REMOTE_INIT=true`. `docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build -d` |
| `docker-compose.images.yml` | manual | Runs the published GHCR images instead of building from source (`build: !reset null`; needs Compose v2.24+). See [container-images.md](container-images.md) |
| `docker-compose.prod.yml` | `make docker-prod` | Resource limits, log rotation, `vault_keys` volume, and hard-required production secrets. **Must be last** |
| `docker-compose.nfs.yml` | manual | Bind-mounts an NFS export at `/var/backups/vault`; requires `BACKUP_NFS_PATH` |
| `docker-compose.e2e.yml` | `make e2e`, nightly CI | Raises the auth rate limits, enables `VAULT_ALLOW_REMOTE_INIT`, and builds the API with the mock SSO extension so the Playwright suite can run unattended |
| `docker-compose.ci.yml` | `make ci` | The containerized quality-gate runner (see below) |

## Running the Playwright E2E suite locally

```bash
make e2e
```

That target runs `fix-ports`, brings the stack up with the E2E overlay
(`docker compose -f docker-compose.yml -f docker-compose.e2e.yml up --build -d`), re-reads the
possibly-bumped ports out of `.env` and exports them (Playwright's config reads `DB_HOST_PORT` /
`API_HOST_PORT` / `WEB_HOST_PORT` straight from `process.env` — nothing loads `.env` for it),
installs Chromium on first run, and then runs `pnpm --filter @project-vault/web test:e2e`.

It sets `E2E_CONFIRM_DB_RESET=true`: **the suite truncates the database it runs against.** That is
the E2E stack's own volume, but do not point it at a database whose contents you care about. The
stack is left running afterwards — `make docker-down` stops it.

## Local quality gates

`make ci` runs the public build, typecheck, lint, migration, RLS, security, test, duplication, and
generated-spec freshness checks inside the CI Docker service. It does not require private planning or
BMAD artifacts. Private story and sprint governance checks live in the companion
`project-vault-private` repository.

Run focused package tests while developing, then run `make ci` once after the complete change set
is ready.

## Recipe: manual QA against a live dev stack (with a mock extension loaded)

> This is a worked recipe for one specific situation — driving a capability-gated UI control in a
> browser against real servers, with a fixture extension loaded. For ordinary setup follow the
> [Operator Quickstart](operator-quickstart.md) instead.

The following is known to work in a fresh git worktree with no prior local setup:

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

3. **Provision the `vault_admin` credential.** Migration `0071_admin_pool_role.sql` creates
   `vault_admin` deliberately *without* a usable password — nothing in `pnpm db:migrate` sets one.
   The password is provisioned separately: by Compose's `admin-provision` service (which
   `make docker-up` / `make bootstrap-docker` bring up), by `make bootstrap`, or by
   `make ci-inner` for the test database. If you migrated the volume directly, as in step 2, none
   of those ran, and the API boots into
   `password authentication failed for user "vault_admin"` /
   `ADMIN_DATABASE_URL could not reach the configured role`. Fix it once per container (the
   `vault_app` line is only needed if that password was changed too):
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
