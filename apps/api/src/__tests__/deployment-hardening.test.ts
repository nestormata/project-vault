/* eslint-disable security/detect-non-literal-fs-filename */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '../../../../')
const API_DOCKERFILE_PATH = 'apps/api/Dockerfile'
const WEB_DOCKERFILE_PATH = 'apps/web/Dockerfile'
const MIGRATE_STAGE_FROM = 'FROM db-builder AS migrate'

const readRepoFile = (path: string) => readFileSync(resolve(root, path), 'utf8')

const dockerRunCommands = (dockerfile: string) =>
  dockerfile
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .filter((line) => line.startsWith('RUN '))
    .map((line) => line.slice(4).trim())

describe('deployment hardening configuration', () => {
  it('runs the web container as the node user', () => {
    const webDockerfile = readRepoFile(WEB_DOCKERFILE_PATH)

    expect(webDockerfile).toMatch(/\nUSER node\n/)
  })

  // Story 9.9 deliberately removed the top-level `USER node` from apps/api/Dockerfile: the
  // container now starts as root so docker-entrypoint.sh can repair BACKUP_STORAGE_PATH
  // ownership, then drops to `node` via `su-exec` immediately before exec'ing the app. The
  // running application process is still never root — the privilege-drop boundary just moved
  // from image config to inside the entrypoint (see that script's own header comment).
  it('runs the api container’s app process as the node user via the entrypoint’s su-exec drop, not a top-level USER', () => {
    const dockerfile = readRepoFile(API_DOCKERFILE_PATH)
    const runnerStage = dockerfile.slice(
      dockerfile.indexOf('AS runner'),
      dockerfile.indexOf(MIGRATE_STAGE_FROM)
    )
    const entrypoint = readRepoFile('apps/api/docker-entrypoint.sh')

    expect(runnerStage).not.toMatch(/\nUSER node\n/)
    expect(entrypoint).toMatch(/exec su-exec node:node ".*"\n?/)
  })

  // Sonar docker:S6471: unlike `runner`, the published `migrate` image never touches a
  // host-mounted volume — it only runs `pnpm --filter @project-vault/db db:migrate` against the
  // database over the network — so it has no reason to default to root.
  it('runs the migrate stage as the node user', () => {
    const dockerfile = readRepoFile(API_DOCKERFILE_PATH)
    const migrateStage = dockerfile.slice(dockerfile.indexOf(MIGRATE_STAGE_FROM))

    expect(migrateStage).toMatch(/\nUSER node\n/)
  })

  it.each([
    ['api', API_DOCKERFILE_PATH],
    ['web', WEB_DOCKERFILE_PATH],
  ])('disables dependency lifecycle scripts in the %s image install steps', (_, path) => {
    // Substring, not exact-command matching: the api Dockerfile merges its npm-install and
    // apk-add RUNs (and its pnpm-install and pnpm-rebuild RUNs) into single `&&`-joined RUN
    // instructions to satisfy Sonar's "merge consecutive RUN" rule, while the web Dockerfile
    // still runs them as separate RUNs — both are equally valid Docker, so this only needs each
    // flag to appear somewhere in the image's RUN commands.
    const commands = dockerRunCommands(readRepoFile(path)).join('\n')

    expect(commands).toContain('npm install -g pnpm@11.21.0 --ignore-scripts')
    expect(commands).toContain('pnpm install --frozen-lockfile --ignore-scripts')
  })

  it.each([
    ['api', API_DOCKERFILE_PATH, ['argon2', 'esbuild']],
    ['web', WEB_DOCKERFILE_PATH, ['esbuild']],
  ])('rebuilds only the required native dependencies in the %s image', (_, path, dependencies) => {
    const rebuildCommands = dockerRunCommands(readRepoFile(path)).filter((command) =>
      command.includes('pnpm rebuild ')
    )

    expect(rebuildCommands).toHaveLength(1)
    const rebuildArgs = rebuildCommands[0]?.split('pnpm rebuild ')[1]?.trim().split(/\s+/)
    expect(rebuildArgs?.sort()).toEqual([...dependencies].sort())
  })

  // Story 9.1 D4/AC-17: pg_dump/pg_restore/psql must be present in the runner stage — a
  // regression guard against a future refactor silently dropping this apk package (which would
  // make backup/restore fail at runtime with an opaque "command not found" instead of a clear,
  // build-time-visible failure).
  it('installs postgresql16-client in the api runner stage (Story 9.1 D4/AC-17)', () => {
    const dockerfile = readRepoFile(API_DOCKERFILE_PATH)
    const runnerStage = dockerfile.slice(dockerfile.indexOf('AS runner'))

    expect(runnerStage).toMatch(/\bapk add --no-cache\b[^\n]*\bpostgresql16-client\b/)
  })

  // Story 9.10 AC-1/AC-2: RELEASE_VERSION must be injectable as a build-arg and available both
  // as OCI metadata (org.opencontainers.image.version label) and, for api/migrate, a
  // runtime-readable env var — with a documented 'dev' default so an unlabeled local build never
  // silently looks like a numbered release.
  it('declares RELEASE_VERSION as a build-arg with a documented dev default in the api migrate and runner stages', () => {
    const dockerfile = readRepoFile(API_DOCKERFILE_PATH)
    const migrateStageStart = dockerfile.indexOf(MIGRATE_STAGE_FROM)
    const runnerStage = dockerfile.slice(dockerfile.indexOf('AS runner'), migrateStageStart)
    const migrateStage = dockerfile.slice(migrateStageStart)

    expect(migrateStageStart).toBeGreaterThan(-1)
    expect(migrateStage).toMatch(/ARG RELEASE_VERSION=dev/)
    expect(migrateStage).toMatch(/LABEL org\.opencontainers\.image\.version=\$RELEASE_VERSION/)
    expect(runnerStage).toMatch(/ARG RELEASE_VERSION=dev/)
    expect(runnerStage).toMatch(/LABEL org\.opencontainers\.image\.version=\$RELEASE_VERSION/)
    // The api runner stage must also expose it at container runtime (consumed by
    // getReleaseVersion() in apps/api/src/lib/package-version.ts) — the migrate image never runs
    // the app so it only needs the label, not the ENV.
    expect(runnerStage).toMatch(/ENV RELEASE_VERSION=\$RELEASE_VERSION/)
  })

  // The release version changes on every publish, so a stage carrying its ARG/LABEL invalidates
  // the cache of every stage built FROM it. `migrate` therefore has to stay a leaf: nothing may
  // derive from it, and `db-builder` (which `app-builder` -> `deploy` -> the runner's COPY all
  // descend from) must not carry the ARG itself.
  it('keeps the release-version ARG out of every api stage other stages build FROM', () => {
    const dockerfile = readRepoFile(API_DOCKERFILE_PATH)
    const dbBuilderStage = dockerfile.slice(
      dockerfile.indexOf('AS db-builder'),
      dockerfile.indexOf('FROM db-builder AS app-builder')
    )

    expect(dbBuilderStage).not.toMatch(/ARG RELEASE_VERSION/)
    expect(dockerfile).not.toMatch(/FROM migrate\b/)
    expect(dockerfile).not.toMatch(/--from=migrate\b/)
  })

  it('declares RELEASE_VERSION as a build-arg with the OCI version label in the web runner stage', () => {
    const dockerfile = readRepoFile(WEB_DOCKERFILE_PATH)
    const runnerStage = dockerfile.slice(dockerfile.indexOf('AS runner'))

    expect(runnerStage).toMatch(/ARG RELEASE_VERSION=dev/)
    expect(runnerStage).toMatch(/LABEL org\.opencontainers\.image\.version=\$RELEASE_VERSION/)
  })

  it('does not expose Postgres on every host interface', () => {
    const compose = readRepoFile('docker-compose.yml')

    expect(compose).not.toContain('"5432:5432"')
    expect(compose).toContain("'127.0.0.1:${DB_HOST_PORT:-5432}:5432'")
  })

  it('passes the vault bootstrap token into the api container', () => {
    const compose = readRepoFile('docker-compose.yml')

    expect(compose).toContain('VAULT_BOOTSTRAP_TOKEN: ${VAULT_BOOTSTRAP_TOKEN:-}')
  })

  it('allows vault bootstrap env vars through turbo dev tasks', () => {
    const turbo = JSON.parse(readRepoFile('turbo.json')) as {
      globalPassThroughEnv?: string[]
    }

    expect(turbo.globalPassThroughEnv).toEqual(
      expect.arrayContaining(['VAULT_BOOTSTRAP_TOKEN', 'VAULT_ALLOW_REMOTE_INIT'])
    )
  })

  it('keeps sensitive and bulky files out of Docker build context', () => {
    const dockerignore = readRepoFile('.dockerignore')

    for (const requiredEntry of [
      '.git',
      '.env*',
      '!/.env.example',
      '.npmrc',
      '.pnpmrc',
      'node_modules',
      'dist',
      'build',
      'coverage',
      '.turbo',
      '.stryker-tmp',
    ]) {
      expect(dockerignore).toContain(requiredEntry)
    }
  })

  it('uses least-privilege GitHub token permissions', () => {
    const ciWorkflow = readRepoFile('.github/workflows/ci.yml')
    const nightlyWorkflow = readRepoFile('.github/workflows/nightly.yml')

    expect(ciWorkflow).toMatch(/\npermissions:\n\s+contents: read\n/)
    expect(nightlyWorkflow).toMatch(/\npermissions:\n\s+contents: read\n/)
  })

  it('allows the API and database test shard enough time to finish before Sonar consumes coverage', () => {
    const ciWorkflow = readRepoFile('.github/workflows/ci.yml')
    const apiDbJob = ciWorkflow.match(/\n  test-api-db:[\s\S]*?(?=\n  test-web-other:)/)?.[0]
    const timeout = apiDbJob?.match(/\n\s+timeout-minutes:\s+(\d+)/)?.[1]

    expect(Number(timeout)).toBeGreaterThanOrEqual(45)
  })

  it('configures Dependabot for pnpm and GitHub Actions updates', () => {
    const dependabot = readRepoFile('.github/dependabot.yml')

    expect(dependabot).toContain('package-ecosystem: "npm"')
    expect(dependabot).toContain('directory: "/"')
    expect(dependabot).toContain('package-ecosystem: "github-actions"')
  })
})
