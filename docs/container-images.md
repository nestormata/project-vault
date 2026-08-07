# Published container images

Project Vault publishes three images to GitHub Container Registry (GHCR):

```text
ghcr.io/nestormata/project-vault/api
ghcr.io/nestormata/project-vault/migrate
ghcr.io/nestormata/project-vault/web
```

Images are built when a GitHub Release with a strict `vMAJOR.MINOR.PATCH` tag is published. For
example, publishing `v1.2.3` produces the immutable release tag `1.2.3` and a commit-SHA tag. Once
all three images succeed, the workflow promotes the `1.2`, `1`, and `latest` aliases.

Use an exact version or digest for production and Portainer deployments. `latest` is a convenience
alias and moves when a newer release is published.

## First publication

The first workflow publication creates GHCR packages. GitHub may create them as private initially.
Open each package's settings under the repository's Packages area, choose **Change visibility**,
and make it public. Public GHCR container images can then be pulled anonymously.

The workflow authenticates with the repository-provided `GITHUB_TOKEN`; no registry password or
long-lived token is required. The publish job has only the package, attestation, and repository
permissions needed for its work.

## Portainer

Use the published images in a Portainer Stack instead of Dockerfile `build:` directives:

```yaml
services:
  migrate:
    image: ghcr.io/nestormata/project-vault/migrate:1.2.3
  api:
    image: ghcr.io/nestormata/project-vault/api:1.2.3
  web:
    image: ghcr.io/nestormata/project-vault/web:1.2.3
```

Keep the existing service environment, dependencies, volumes, health checks, and production
hardening from `docker-compose.yml` and `docker-compose.prod.yml`. The `migrate` service must keep
its existing migration command and must complete before `api` starts.

For a private package, configure a Portainer registry credential with pull access. For a public
package, no registry credential is needed.

## Manual recovery

The workflow also supports `workflow_dispatch`. Supply an existing strict-semver tag such as
`v1.2.3` to rebuild and republish the image set. The tag must already exist in the repository.
