# Published container images

Project Vault publishes three images to GitHub Container Registry (GHCR):

```text
ghcr.io/nestormata/project-vault/api
ghcr.io/nestormata/project-vault/migrate
ghcr.io/nestormata/project-vault/web
```

These are the canonical repository paths. A fork or renamed copy is published under its own
`ghcr.io/<owner>/<repository>` namespace; replace the examples accordingly.

Images are built when a GitHub Release with a strict `vMAJOR.MINOR.PATCH` tag is published. For
example, publishing `v1.2.3` produces the immutable release tag `1.2.3` and a long commit-SHA tag.
Once all three images succeed, the workflow promotes the `1.2`, `1`, and `latest` aliases.

Use an exact version or digest for production and Portainer deployments. `latest` is a convenience
alias and moves when a newer release is published.

Each published image also carries an `org.opencontainers.image.version` label matching the release
tag (`docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}'
<image>`), and the running `api` image additionally sets the same value as the `RELEASE_VERSION`
environment variable (the `migrate` image carries the label only — it never runs the app, so it
has no runtime environment to read) — this is the same source the deployed `api`'s `/health` and `/status`
responses, its OpenAPI `info.version`, and its `STARTUP_COMPLETE` startup log all report, so the
image label, the container env, and every version-reporting surface always agree. See
`docs/runbook.md` § Upgrades § Release-identity source for the full injection/verification
pipeline.

## First publication

The first workflow publication creates GHCR packages. GitHub may create them as private initially.
Open each package's settings under the repository's Packages area, choose **Change visibility**,
and make it public. Public GHCR container images can then be pulled anonymously.

The workflow authenticates with the repository-provided `GITHUB_TOKEN`; no registry password or
long-lived token is required. The publish job has only the package, attestation, and repository
permissions needed for its work.

## Portainer

The following is an image-override fragment, not a complete standalone Portainer stack. Start with
the existing `docker-compose.yml` or `docker-compose.prod.yml`, replace each service's `build:`
block with the matching `image:`, and preserve the rest of the stack contract:

```yaml
services:
  migrate:
    image: ghcr.io/nestormata/project-vault/migrate:1.2.3
  api:
    image: ghcr.io/nestormata/project-vault/api:1.2.3
  web:
    image: ghcr.io/nestormata/project-vault/web:1.2.3
```

Keep the existing service environment, database, ports, dependencies, volumes, health checks, and
production hardening from the compose file. The `migrate` service must keep its existing migration
command and must complete before `api` starts.

For a private package, configure a Portainer registry credential with pull access. For a public
package, no registry credential is needed.

## Manual recovery

The workflow also supports `workflow_dispatch`. Supply an existing strict-semver tag such as
`v1.2.3` from the `main` branch. The tag must already exist in the repository, and the workflow
refuses to overwrite an existing immutable `1.2.3` image tag. This protects release tags from
silent rebuilds; correct the source and publish a new release tag when a previously published
release needs a rebuilt image.
