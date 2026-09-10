# Upgrades: in-place version upgrade and the offline migration path

<!-- Verified against docker-compose.yml, docker-compose.images.yml, docker-compose.prod.yml,
     packages/db/src/scripts/guarded-migrate.ts, scripts/migration-compatibility-check.ts,
     apps/api/src/lib/package-version.ts, apps/api/Dockerfile, apps/web/Dockerfile,
     .github/workflows/container-publish.yml -->

## When to use

Moving a running instance from one release to another. Read
[`upgrade-notes.md`](upgrade-notes.md) **first** — some versions have a required pre-step that must
happen before the new image starts.

---

## In-place version upgrade

### Step 1 — pick your upgrade path

There are two supported deployment shapes, and they upgrade differently. `docker-compose.prod.yml`
contains **no `image:` lines** of its own — it is a hardening overlay (memory limits, restart
policy, volumes, `${VAR:?}` secret requirements), not an image pin. Which path you are on is decided
by whether you layer `docker-compose.images.yml`.

**(a) Source-built** (the default `docker-compose.yml`, which has `build:` blocks for `migrate`,
`api` and `web`). `docker compose pull` does **not** update these services — it only pulls
`postgres`/`mailpit`. Check out the release tag and rebuild:

```bash
git fetch --tags
git checkout v1.2.3
docker compose -f docker-compose.yml -f docker-compose.prod.yml build --pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

**(b) Image-based**, using the published GHCR images via the `docker-compose.images.yml` overlay.
Pin the tag in `.env` (`VAULT_IMAGE_TAG=1.2.3`; use `VAULT_IMAGE_REPO` for a fork), then:

```bash
docker compose -f docker-compose.yml -f docker-compose.images.yml -f docker-compose.prod.yml pull
docker compose -f docker-compose.yml -f docker-compose.images.yml -f docker-compose.prod.yml up -d
```

The overlay must go **after** `docker-compose.yml` and **before** `docker-compose.prod.yml`, so the
prod overlay's `${VAR:?}` secret requirements stay last and win. See
[`docs/container-images.md`](../container-images.md) for image names, tag/alias semantics, digest
pinning, and Portainer usage.

Use an exact version or digest in production. `latest` moves when a newer release is published.

### Step 2 — let the migrate service run

`docker compose up -d` runs the one-shot `migrate` service, which executes
`pnpm --filter @project-vault/db db:migrate` (the guarded wrapper,
`packages/db/src/scripts/guarded-migrate.ts`) before `api` starts, since `api` depends on `migrate`
completing successfully. A destructive migration aborts the wrapper with a non-zero exit code (see
"Identifying a destructive migration" below) — `api` then **never starts**, leaving whatever was
running before (if not yet torn down) as the last known-good state. Do not force-start `api` against
a database mid-refusal.

On the source-built path, the first `docker compose up` after a fresh checkout can be slow: the
`migrate` service rebuilds the API builder image to run the migration command. This is a known,
accepted tradeoff — it is progress, not a hang.

### Step 3 — verify

```bash
curl -sf http://localhost:${API_HOST_PORT}/ready    # {"status":"ready"}
curl -sf http://localhost:${API_HOST_PORT}/health   # {"status":"ok","version":"1.2.3","versionSource":"release"}
```

`/health`'s `version` is the authoritative deployed-version check. You can also spot-check
`GET /api/v1/openapi.json`'s `info.version`, but that route (and the Swagger UI at
`/api/v1/docs`) is only registered when `ENABLE_API_DOCS=true` or `NODE_ENV` is
`development`/`test` — it is **off by default in production**, and should stay off on an
internet-reachable instance.

Remember that the vault is sealed after any restart: complete a manual unseal
([`vault-lifecycle.md`](vault-lifecycle.md)) before `/ready` will return `ready`.

### Rollback

Re-point at the previous tag (checkout + rebuild, or `VAULT_IMAGE_TAG=<previous>` + `pull`/`up -d`)
and restart. **This is only safe if no destructive migration was part of the failed upgrade** — a
rolled-back image against a forward-migrated schema is a mismatch, and needs the offline procedure
below rather than a plain image swap. Check [`upgrade-notes.md`](upgrade-notes.md) for the version
you are leaving before assuming a rollback is clean.

---

## Release-identity source

Every surface that reports a version comes from **one source of truth**: the `RELEASE_VERSION`
build-arg/env var, resolved by `getReleaseVersion()` (`apps/api/src/lib/package-version.ts`). That
is `/health`'s `version`/`versionSource`, the protected `/status` endpoint's `version`, the OpenAPI
`info.version`, the `STARTUP_COMPLETE` operational log's `serviceVersion`, the Version & Upgrade
page (which reads `/health`), and every published image's `org.opencontainers.image.version` OCI
label — so `/health` and `/status` can never disagree about what is running.

`apps/api/package.json`'s `"version"` field (and every other workspace package's) intentionally
stays a permanent `0.0.1` development placeholder and is never read as release identity — do not
"fix" a `0.0.1` report by bumping a manifest.

- **Where it is injected:** `.github/workflows/container-publish.yml`'s `build-publish` job passes
  `build-args: RELEASE_VERSION=<the validated vMAJOR.MINOR.PATCH release tag, without the v>` to
  `docker/build-push-action`, and adds the same value as the `org.opencontainers.image.version`
  label via `docker/metadata-action`. `apps/api/Dockerfile` declares `ARG RELEASE_VERSION=dev` in
  both the `migrate` and `runner` stages, and additionally sets `ENV RELEASE_VERSION=$RELEASE_VERSION`
  in `runner` so the running process can read it. `migrate` is a leaf stage that is
  filesystem-identical to `db-builder` and adds only the OCI label: because the release version
  changes on every publish, a stage carrying that `ARG` invalidates the build cache of everything
  built `FROM` it, so it must never live in `db-builder` (which `builder` → `deploy` → the api
  runner's `COPY` all descend from). `apps/web/Dockerfile` declares the same `ARG`/`LABEL` in its
  `runner` stage for OCI metadata parity — the web app never reads `RELEASE_VERSION` directly, since
  Version & Upgrade sources its version from the API's `/health`.
- **Development fallback:** any build that does not pass the `RELEASE_VERSION` build-arg (a bare
  `docker build`, `make docker-up`, `pnpm dev`) reports the literal `dev` and
  `versionSource: "development"` everywhere — never a numbered version, and never `0.0.1`. An
  explicitly set `RELEASE_VERSION=dev` (the Dockerfile's own default, so also what a compose
  `environment:` copy-paste produces) and a blank/whitespace-only value are both treated as "no
  release version injected", never as a release build.
- **CI verification:** after each image is built, tagged, and pushed, a "Verify published image
  version matches the release tag" step inspects the pushed image's `org.opencontainers.image.version`
  label (all three images) and, for the `api` image, the baked-in runtime `RELEASE_VERSION` env var,
  and fails the workflow run — **before** `promote-aliases` can create/move the `latest`/major/minor
  alias tags — if either disagrees with the release tag.

### If that verification step fails

The alias tags are correctly left untouched, but the immutable `:VERSION` tag has **already been
pushed** (verification runs post-push, on the published digest). A plain re-run of the workflow will
therefore stop at its "Reject existing immutable release tag" guard, which is working as designed —
release tags are never silently overwritten. After fixing the underlying wiring, recover one of two
ways:

1. **Preferred** — publish the next patch release (`v1.2.4`). The bad `1.2.3` tag exists but no alias
   ever pointed at it, so no `latest`/major/minor consumer was exposed to it.
2. **Reuse the same version** — delete the bad package version first (repository → Packages → the
   affected image → **Manage versions** → delete the `1.2.3` version; do this for every image the
   failed run pushed), then re-run the workflow via its `workflow_dispatch` recovery input. Only do
   this while no consumer can have pulled the tag.

### Manually verify a local build

The image must be tagged with `-t`, or the following two commands have nothing to reference:

```sh
docker build --build-arg RELEASE_VERSION=1.2.3 \
  -f apps/api/Dockerfile --target runner -t pv-api-version-check .
docker run --rm pv-api-version-check node -e 'console.log(process.env.RELEASE_VERSION)'
docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' \
  pv-api-version-check
```

Both print `1.2.3`. Rebuild without `--build-arg` and both print `dev` instead, confirming the
development fallback.

---

## Identifying a destructive migration and the offline migration path

### Pre-flight check

No database connection required — a pure static scan of every committed migration file:

```bash
pnpm check-migration-compatibility
```

> This is the currently-shipped command name (`package.json`'s `check-migration-compatibility`
> script, which runs `tsx scripts/migration-compatibility-check.ts`). Some older documents refer to
> it as `pnpm migration-compatibility-check` — that is the filename, not the script name.

Exits `0` if no committed migration is destructive. If one or more are, it prints every offending
file/finding and exits non-zero — no data or database is touched either way.

### Runtime refusal

Independently of the pre-flight check, the guarded `db:migrate` wrapper refuses any **pending**
destructive migration automatically during the upgrade's `docker compose up -d` step, whether or not
you pre-checked. The exact refusal text it writes to stderr:

```
FATAL: migration 0036_drop_legacy_column.sql contains a destructive operation:
  DROP COLUMN (line 3)
In-place auto-migration refuses destructive schema changes (AC-E9b).
Follow the documented offline migration procedure (see docs/runbook.md § Upgrades),
or re-run with --allow-destructive if you have already completed that procedure.
```

The per-finding line is the operation label plus a line number — e.g. `DROP COLUMN (line 3)`,
`DROP TABLE (line 7)`, `RENAME COLUMN (line 2)`. It does not name the specific column/table being
dropped; read the cited migration file directly for that detail.

### Offline migration path

Once a genuine destructive change must ship:

1. Take a fresh, verified backup first ([`backup-restore.md`](backup-restore.md)) — never attempt a
   destructive migration without one in hand.
2. Stop the API container so no traffic hits the database mid-migration: `docker compose stop api`.
3. Manually review the destructive statement's data impact (e.g. confirm a `DROP COLUMN` target is
   genuinely unused, not silently relied on elsewhere).
4. Run the migration explicitly with the escape hatch:
   `pnpm --filter @project-vault/db db:migrate --allow-destructive`.
5. Verify data integrity post-migration (spot-check row counts; run the test suite against a staging
   copy first if at all possible).
6. Restart the API and verify: `docker compose up -d api`, unseal, then
   `curl -sf http://localhost:${API_HOST_PORT}/ready`.

**Do not reflexively re-run with `--allow-destructive`** the moment you see a refusal. The scanner
has documented false-positive guards (e.g. an identifier merely containing the substring "rename" is
not flagged) — if you do see a refusal, it is a genuine keyword match. Read the named file/line
first; `--allow-destructive` bypasses the safety check entirely rather than re-verifying it.

### Rollback

Restoring a backup taken before a since-applied destructive migration leaves the restored schema
mismatched with the currently-deployed application version — roll the image back to match first, or
treat it with the same offline-migration care as a destructive upgrade, not a routine restore.
