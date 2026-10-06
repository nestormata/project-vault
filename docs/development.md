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

| Overlay                           | Applied by                                                | What it does                                                                                                                                                                                                                                                                     |
| --------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker-compose.dev.yml`          | manual                                                    | Bind-mounts `apps/*/src`, runs the API with `pnpm dev` (hot reload) and sets `VAULT_ALLOW_REMOTE_INIT=true`. `docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build -d`                                                                                      |
| `docker-compose.images.yml`       | manual                                                    | Runs the published GHCR images instead of building from source (`build: !reset null`; needs Compose v2.24+). See [container-images.md](container-images.md)                                                                                                                      |
| `docker-compose.prod.yml`         | `make docker-prod`                                        | Resource limits, log rotation, `vault_keys` volume, and hard-required production secrets. **Must be last**                                                                                                                                                                       |
| `docker-compose.nfs.yml`          | manual                                                    | Bind-mounts an NFS export at `/var/backups/vault`; requires `BACKUP_NFS_PATH`                                                                                                                                                                                                    |
| `docker-compose.e2e.yml`          | `make e2e`, nightly CI                                    | Raises the auth rate limits, enables `VAULT_ALLOW_REMOTE_INIT`, builds the API with the mock SSO extension, and enables the CentralizeMe handoff with a **test-only** key so the Playwright suite can run unattended (see [Handoff on the E2E stack](#handoff-on-the-e2e-stack)) |
| `docker-compose.mock-ui-pack.yml` | `make mock-ui-pack-e2e` (`E2E_STACK_FLAVOR=mock-ui-pack`) | Layers on the e2e override: the composed web image, the mock module pack in the real API (`VAULT_EXTENSIONS_REQUIRED=true`), loopback ports allocated for one run, and a profile-gated `api-faulty` service for the fail-closed boot proof. Test only, never a deploy file       |
| `docker-compose.ci.yml`           | `make ci`                                                 | The containerized quality-gate runner (see below)                                                                                                                                                                                                                                |
| `docker-compose.ci-overlay.yml`   | `make ci`, only when the private overlay resolves         | Mounts the private overlay repo read-only at its own absolute host path (see below)                                                                                                                                                                                              |

## Composition mechanism checks (Story 68.10)

```bash
make composition-kit-integration   # the kit's mini pack, per feature, against an API stub
make mock-ui-pack-compose          # the compose stage only: mock UI pack onto the packed web-host (no Docker)
make mock-ui-pack-e2e               # the whole mechanism e2e: composed image, real API + database, Playwright
make mock-ui-pack-e2e SPEC=e2e/mechanism/m7-api-routes.spec.ts   # one capability (no `--`)
pnpm check-monolithic-regions      # every @region block is a component or contains one
pnpm vitest run scripts/check-pv-cm-free-build.test.ts   # PV's own CM-free build: the control group
```

The `make` targets run on the host (the `make ci` container has no Docker CLI and no registry
access), install from the public npm registry and take minutes (`mock-ui-pack-e2e` also needs Docker). `make ci-inner` runs only the guard,
the wiring tests and the control group (which builds `apps/web` once).

## Running the Playwright E2E suite locally

```bash
make e2e                                                    # the whole suite
make e2e SPEC=e2e/journeys/j28-handoff-confirmation.spec.ts # one spec
```

That target runs `fix-ports`, starts the stack with the E2E overlay through
`scripts/e2e-stack.sh start` (the same script nightly CI uses), re-reads the possibly-bumped ports
out of `.env` and exports them (Playwright's config reads `DB_HOST_PORT` / `API_HOST_PORT` /
`WEB_HOST_PORT` straight from `process.env` — nothing loads `.env` for it), installs Chromium on
first run, and then runs `pnpm --filter @project-vault/web-host test:e2e`.

It sets `E2E_CONFIRM_DB_RESET=true`: **the suite truncates the database it runs against.** That is
the E2E stack's own volume, but do not point it at a database whose contents you care about. The
stack is left running afterwards — `make docker-down` stops it.

### Throwaway secrets

The E2E api runs with `NODE_ENV=production` on purpose (the suite exercises the shipped
configuration), so it rejects the dev-only secret defaults in `docker-compose.yml`.
`scripts/e2e-stack.sh` therefore generates the 12 production secrets fresh for every stack start
(`openssl rand -hex 32`, all distinct). They live only in that script's own process: never written
to `.env` or anywhere in the repo, never printed, and gone when it exits. They are **never real
secrets** and are worthless after the run. A value you already exported yourself is kept (the
script names it, never prints it), unless it is one of the dev literals or duplicates another key,
in which case the script stops before building anything.

Always start the E2E stack through the script (`make e2e`, or `./scripts/e2e-stack.sh up` then
`./scripts/e2e-stack.sh wait`). A bare `docker compose -f docker-compose.yml -f docker-compose.e2e.yml up`
recreates the api with the dev literals and it dies at boot. If the api does not answer `/health`
within 120 s (`E2E_HEALTH_ATTEMPTS` × `E2E_HEALTH_INTERVAL_SECONDS`, default 40 × 3), or a container
exits, the script prints `docker compose ps -a` and the `migrate` / `admin-provision` / `api` logs
before failing, so the cause is in the output.

### Running one spec

- `make e2e SPEC=<path>` appends the path to `test:e2e`. Pass a **path**, ideally the full one
  (`e2e/journeys/j28-handoff-confirmation.spec.ts`); spaces and shell metacharacters are not
  supported.
- The filter is a regex over the file path: `SPEC=j1` also runs `j10-…` through `j19-…`. Use the
  full path, or at least the prefix with its dash (`SPEC=j1-`).
- A `SPEC` that matches nothing fails with Playwright's `No tests found`.
- Isolated-stack journeys (j19-j27, for example j26) boot the API on the host with `tsx`, so the
  workspace packages it imports need a built `dist/`, which `make e2e` does not build (the docker
  stack builds its own). In a fresh checkout or worktree run `pnpm turbo build` first, or at least
  `shared`, `extension-api`, `crypto`, then `db` (`db` needs `crypto` built); j25 and j27 also need
  `fixtures/mock-ui-panel-extension` built. Without it the child dies before `/health` with
  `ERR_MODULE_NOT_FOUND ... @project-vault/db/dist/index.js` and no `startup.failed` line (a missing
  fixture build instead gives `extensions_status: "load_failed"` on `/health`).
- Stack already up and you only want to re-run a spec, without a rebuild: from the repo root, with
  the worktree's `DB_HOST_PORT` / `API_HOST_PORT` / `WEB_HOST_PORT` set in your shell and
  `E2E_CONFIRM_DB_RESET=true`:
  `pnpm --filter @project-vault/web-host test:e2e e2e/journeys/j28-handoff-confirmation.spec.ts`.
- **Do not put `--` before the spec.** pnpm forwards extra arguments as-is, so
  `test:e2e -- <spec>` hands Playwright a literal `--`, after which it ignores the filter and runs
  **every** journey. Also go through `test:e2e`, not `pnpm exec playwright test`: j26's isolated
  stack needs the `npm_execpath` a pnpm script sets.

### Isolated-stack journeys (j19-j22, j25-j27)

These journeys spawn their own `apps/api` process (tsx, `NODE_ENV=test`) against a dedicated
database on the e2e Postgres (Story 66.4):

- A boot failure always prints one `startup.failed` JSON line on the API's stderr (shown as
  `[api-…:<port>] …`), and the fixture fails within a second with
  `isolated api <label>:<port> exited before /health (code=…, signal=…): <reason>` instead of a
  20 s `/health` timeout.
- The API is quiet by default (`LOG_LEVEL=silent`). Set one knob to see its normal logs:
  `J19_DEBUG_LOG_LEVEL`, `J20_DEBUG_LOG_LEVEL`, `J25_DEBUG_LOG_LEVEL`, `J26_DEBUG_LOG_LEVEL`,
  `J27_DEBUG_LOG_LEVEL`, `E2E_AUDIT_QUOTA_LOG_LEVEL` (j21), `E2E_AUDIT_RATE_LIMIT_LOG_LEVEL` (j22),
  e.g. `J19_DEBUG_LOG_LEVEL=info`.
- Before spawning, the fixture runs `SELECT 1` as `vault_app` and as `vault_admin`. The
  `vault_admin` URL is `E2E_ADMIN_DATABASE_URL` if set, else it uses `VAULT_ADMIN_PASSWORD`
  (default `password`), mirroring Compose's `${VAULT_ADMIN_PASSWORD:-password}`. If your stack
  uses a non-default `VAULT_ADMIN_PASSWORD`, export the same value in the Playwright shell
  (`make e2e` does not read it from your env file).
- If `vault_admin` has no password yet (a freshly migrated DB) and `E2E_CONFIRM_DB_RESET=true`,
  the fixture sets it once and prints
  `[isolated-stack] provisioned vault_admin credential on localhost:<port> (role had no password)`.
  It only does so when both the superuser URL and the `vault_admin` URL are loopback on this
  worktree's `DB_HOST_PORT`, never overwrites an existing password, and never touches
  `vault_app`.

### Handoff on the E2E stack

Since Story 60.6 the E2E stack runs the CentralizeMe -> PV handoff for real, so
`j31-handoff-cross-site-real-token.spec.ts` can drive a signed token through a cross-site
`prepare`, the claim exchange, Confirm and a session:

- The api gets `VAULT_HANDOFF_ENABLED=true`, `VAULT_HANDOFF_INSTANCE_ID=pv-e2e`, a literal
  `VAULT_HANDOFF_ISSUER`, and `VAULT_HANDOFF_VERIFY_KEYS` with one **test-only** Ed25519 public key
  (kid `pv-e2e-test-only-1`). Its private half is derived at test time from a fixed, public seed in
  `apps/web/e2e/fixtures/handoff-test-key.ts`; no private key is committed.
- That key is public by design and is trusted only for `aud = pv:pv-e2e`. **Never reuse the E2E
  override, this kid or this instance id outside the E2E stack.** `scripts/e2e-stack.test.ts` (run in
  PR CI) fails if any of them appears in `docker-compose.yml`, a `fly*.toml` or the example
  configuration file, and pins the override to the fixture's constants.
- The web gets `VAULT_HANDOFF_ENABLED=true`, an empty `VAULT_HANDOFF_ISSUER` (so j28 sees the
  plain-text guidance whatever your local config says) and a `CORS_ALLOWED_ORIGINS` that also admits j31's
  fake CentralizeMe page on `http://127.0.0.1:${E2E_HANDOFF_STUB_PORT:-48999}`. j31 starts that
  listener itself (127.0.0.1 only). The allowlist is fixed when the stack starts, so if you
  override `E2E_HANDOFF_STUB_PORT`, set it in your shell for the whole `make e2e` run, not just for
  Playwright. j31 also uses the next port up (`48999 + 1`) as a deliberately non-allowlisted site.

### Re-runs and concurrency

- Re-running `make e2e` while the worktree's stack is up generates new secrets, so compose
  recreates the api: the vault is uninitialized again and every earlier session cookie is invalid.
  That is expected; `global-setup.ts` resets the database and re-initializes the vault. Because
  `fix-ports` sees the running stack's own ports as busy, the ports can also move on a re-run.
- Two worktrees can run `make e2e` at the same time: compose project names and DB/API/WEB ports
  differ per worktree, and the E2E overlay publishes no Mailpit host ports. The one shared step is
  the Chromium install step (`playwright install --with-deps` runs `apt-get` on every run): if two
  runs reach it at the same moment, one can fail with `Could not get lock /var/lib/apt/lists/lock`.
  Stagger the starts, or re-run the one that failed. j31's fake CentralizeMe listener is also
  host-wide: two worktrees running j31 at the same moment collide on `E2E_HANDOFF_STUB_PORT`
  (the second fails fast naming the variable); give one of them a different port. Each worktree's images
  cost about 1.6 GB; `docker compose -f docker-compose.yml -f docker-compose.e2e.yml down -v --rmi local`
  removes a finished worktree's stack, volumes and images.
- Two `make e2e` runs in the **same** worktree at once are unsupported: they share one compose
  project and one database, which `global-setup.ts` truncates under the other run.

## Base image refresh

Every shipped image builds from a digest-pinned base: `FROM <image>@sha256:<digest>` (the multi-arch
index digest, a bare digest by design: Sonar S8431 flags tag plus digest as redundant). Two image
families are pinned: `node` (`node:24-alpine`; six lines in `apps/api/Dockerfile` (builder, runner,
migrate), `apps/web/Dockerfile` (builder, runner) and `Dockerfile.ci`) and `postgres`
(`postgres:16-alpine`; one line in `deploy/fly/db/Dockerfile`, the Fly demo db image). Each family
stays in lockstep. `scripts/check-base-image-digest.test.ts` discovers every Dockerfile in the
repo by name (no list to edit when you add one), rejects any floating external `FROM` (also
`COPY --from=` and `RUN --mount=...from=`), and fails if a Dockerfile named by a fly toml, compose
file, workflow or script is not discovered, or if a pinned family is unknown to the refresh script.
It cannot judge whether a digest is recent: the image scan gates and the refresh below do that.

`.github/workflows/base-image-refresh.yml` runs weekly (and on `workflow_dispatch`). For each family
that `scripts/refresh-base-image.sh images` lists, it resolves the current digest from Docker Hub with
an anonymous token, refuses a registry rollback (older `libssl3`), rewrites only the changed
family's `FROM` lines with `scripts/refresh-base-image.sh rewrite --image <name>`, force-pushes
`chore/base-image-refresh` and opens or updates a single `base-image`-labelled PR (one PR even when
both families moved). The Fly db image has no `apk upgrade` step: OS fixes arrive only through this
reviewed refresh. A PR opened with `GITHUB_TOKEN` does not
trigger `pull_request` workflows, so the job also runs `gh workflow run ci.yml --ref
chore/base-image-refresh`; the checks (including the blocking image scan) appear on the PR head
commit. The PR is never auto-merged: review the checks, then merge by hand. To refresh by hand, run
`gh workflow run base-image-refresh.yml`. `scripts/update-base-image.sh` only prints a digest from a
local Docker pull.

## Local quality gates

`make ci` runs the public build, typecheck, lint, migration, RLS, security, test, duplication, and
generated-spec freshness checks inside the CI Docker service. It does not require the maintainer's
private planning overlay. Story and sprint governance checks over that overlay's data run only when
it is attached.

After the container run, `make ci` runs two checks on the **host**, because the CI container has no
Docker CLI: `docker-backup-permission-smoke` and the `docker compose config` contract suite
(`scripts/check-compose-config.test.ts`, Story 60.7). The second needs a host `pnpm install`; without
it `make ci` fails loudly rather than skipping.

When the private planning overlay is attached, `make ci` also mounts it
**read-only at its own absolute host path** (`docker-compose.ci-overlay.yml`), so the overlay
symlinks that `Dockerfile.ci`'s `COPY . .` carries into `/app` resolve inside the container and the
overlay guards (`check-story-status-sync`, `check-sprint-status-rollup`, `check-deferred-work-ids`,
and the other overlay scans) check real data. The Makefile derives the overlay root by resolving
one of the overlay's symlinked files and prints which case applies
(`make ci: private overlay mounted read-only from ...` or `... not found; overlay guards will print
SKIPPED`). Without the overlay (a public-only clone, public GitHub CI, a cloud session without it)
those guards print `SKIPPED — <path> not found ...; nothing checked` and exit 0; they never print a
false `— OK`. `.claude/` (including every git worktree) is excluded from the build context by
`.dockerignore`.

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
   `vault_admin` deliberately _without_ a usable password — nothing in `pnpm db:migrate` sets one.
   The password is provisioned separately: by Compose's `admin-provision` service (which
   `make docker-up` / `make bootstrap-docker` bring up), by `make bootstrap`, or by
   `make ci-inner` for the test database. If you migrated the volume directly, as in step 2, none
   of those ran, and the API refuses to start with one `startup.failed` JSON line on **stderr**
   whose `err.message` reads
   `API will not start: ADMIN_DATABASE_URL could not reach the configured role (reason: auth_failed); …`
   (`password authentication failed for user "vault_admin"` is what `psql` prints; the API only
   reports the allowlisted reason code). The isolated e2e fixtures (j19-j27) provision a
   passwordless `vault_admin` themselves when `E2E_CONFIRM_DB_RESET=true` (as `make e2e` sets);
   for `pnpm turbo dev` fix it once per container (the `vault_app` line is only needed if that
   password was changed too):

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
