# Published container images

Project Vault publishes three images to GitHub Container Registry (GHCR):

```text
ghcr.io/nestormata/project-vault/api
ghcr.io/nestormata/project-vault/migrate
ghcr.io/nestormata/project-vault/web
```

These are the canonical repository paths. A fork or renamed copy is published under its own
`ghcr.io/<owner>/<repository>` namespace; replace the examples accordingly.

Each image is built for `linux/amd64` and `linux/arm64`, so the same tag runs on x86 servers and
Apple Silicon / ARM hosts.

Images are built **only** when a GitHub Release with a strict `vMAJOR.MINOR.PATCH` tag is
published — a push to `main` publishes nothing. For example, publishing `v1.2.3` produces the
immutable release tag `1.2.3` and a long commit-SHA tag. Once all three images succeed, the
workflow promotes the `1.2`, `1`, and `latest` aliases.

Use an exact version or digest for production and Portainer deployments. `latest` is a convenience
alias and moves when a newer release is published.

## Running the published images

Use the `docker-compose.images.yml` overlay that ships with the repository — it sets
`build: !reset null` on `migrate`, `api` and `web`, which removes the base file's `build:` blocks
entirely. Without that reset, layering an image-only fragment leaves the `build:` sections in
place and `docker compose up --build` (or `make docker-up`, which always passes `--build`) quietly
rebuilds from source instead of using the image you pinned.

`!reset` requires Docker Compose **v2.24 or newer** — check with `docker compose version`.

```bash
# pin the release (or export it in the shell)
printf 'VAULT_IMAGE_TAG=%s\n' '1.2.3' >> .env

docker compose -f docker-compose.yml -f docker-compose.images.yml pull
docker compose -f docker-compose.yml -f docker-compose.images.yml up -d
```

`docker compose pull` is a separate step on purpose: it fetches the images ahead of `up`, so a
registry problem surfaces before anything is stopped, and it is how you refresh a moving alias
such as `latest`.

The overlay goes **after** `docker-compose.yml` and **before** `docker-compose.prod.yml`, which
must stay last so its hard-required production secrets win:

```bash
docker compose -f docker-compose.yml -f docker-compose.images.yml -f docker-compose.prod.yml pull
docker compose -f docker-compose.yml -f docker-compose.images.yml -f docker-compose.prod.yml up -d
```

`VAULT_IMAGE_REPO` (default `ghcr.io/nestormata/project-vault`) points the overlay at a fork's own
namespace.

### Pinning by digest

A tag can be re-pointed; a digest cannot. For a fully reproducible deployment, resolve the digest
once and pin it:

```bash
docker buildx imagetools inspect ghcr.io/nestormata/project-vault/api:1.2.3 --format '{{.Manifest.Digest}}'
# sha256:0123456789abcdef...
```

Then set the image explicitly in your own overlay file:

```yaml
services:
  api:
    build: !reset null
    image: ghcr.io/nestormata/project-vault/api@sha256:0123456789abcdef...
  migrate:
    build: !reset null
    image: ghcr.io/nestormata/project-vault/migrate@sha256:...
    command: ['pnpm', '--filter', '@project-vault/db', 'db:migrate']
  web:
    build: !reset null
    image: ghcr.io/nestormata/project-vault/web@sha256:...
```

A multi-arch tag's digest is the manifest-list digest, so a single pinned value still resolves
correctly on both amd64 and arm64 hosts.

Each published image also carries an `org.opencontainers.image.version` label matching the release
tag (`docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}'
<image>`), and the running `api` image additionally sets the same value as the `RELEASE_VERSION`
environment variable (the `migrate` image carries the label only — it never runs the app, so it
has no runtime environment to read) — this is the same source the deployed `api`'s `/health` and `/status`
responses, its OpenAPI `info.version`, and its `STARTUP_COMPLETE` startup log all report, so the
image label, the container env, and every version-reporting surface always agree. See
[the release-identity source in the upgrades runbook](runbooks/upgrades.md) for the full
injection and verification pipeline.

## First publication

The first workflow publication creates GHCR packages. GitHub may create them as private initially.
Open each package's settings under the repository's Packages area, choose **Change visibility**,
and make it public. Public GHCR container images can then be pulled anonymously.

The workflow authenticates with the repository-provided `GITHUB_TOKEN`; no registry password or
long-lived token is required. The publish job has only the package, attestation, and repository
permissions needed for its work.

## Portainer

Portainer stacks accept a single compose document, so paste `docker-compose.yml` and apply the
image overrides inline rather than layering a second file. The fragment below is the same content
`docker-compose.images.yml` provides — an override, not a standalone stack:

```yaml
services:
  migrate:
    build: !reset null
    image: ghcr.io/nestormata/project-vault/migrate:1.2.3
    # Required: the published migrate image's own default command exits 0 without migrating.
    command: ['pnpm', '--filter', '@project-vault/db', 'db:migrate']
  api:
    build: !reset null
    image: ghcr.io/nestormata/project-vault/api:1.2.3
  web:
    build: !reset null
    image: ghcr.io/nestormata/project-vault/web:1.2.3
```

Keep the existing service environment, database, ports, dependencies, volumes, health checks, and
production hardening from the compose file. The `migrate` service must complete before `api`
starts, and `admin-provision` must run after it.

For a private package, configure a Portainer registry credential with pull access. For a public
package, no registry credential is needed.

## Manual recovery

The workflow also supports `workflow_dispatch`. Supply an existing strict-semver tag such as
`v1.2.3` from the `main` branch. The tag must already exist in the repository, and the workflow
refuses to overwrite an existing immutable `1.2.3` image tag. This protects release tags from
silent rebuilds; correct the source and publish a new release tag when a previously published
release needs a rebuilt image.
