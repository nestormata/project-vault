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

## CodeQL language coverage

The public repository's CodeQL default setup scans GitHub Actions and JavaScript/TypeScript. Private
BMAD tooling is maintained in the companion private repository, so Python is intentionally not part
of the public CodeQL language set. Update the repository CodeQL default-setup configuration whenever
the public language footprint changes.
