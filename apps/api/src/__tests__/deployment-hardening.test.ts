/* eslint-disable security/detect-non-literal-fs-filename */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '../../../../')

const readRepoFile = (path: string) => readFileSync(resolve(root, path), 'utf8')

describe('deployment hardening configuration', () => {
  it('runs api and web containers as the node user', () => {
    const apiDockerfile = readRepoFile('apps/api/Dockerfile')
    const webDockerfile = readRepoFile('apps/web/Dockerfile')

    expect(apiDockerfile).toMatch(/\nUSER node\n/)
    expect(webDockerfile).toMatch(/\nUSER node\n/)
  })

  // Story 9.1 D4/AC-17: pg_dump/pg_restore/psql must be present in the runner stage — a
  // regression guard against a future refactor silently dropping this apk package (which would
  // make backup/restore fail at runtime with an opaque "command not found" instead of a clear,
  // build-time-visible failure).
  it('installs postgresql16-client in the api runner stage (Story 9.1 D4/AC-17)', () => {
    const dockerfile = readRepoFile('apps/api/Dockerfile')
    const runnerStage = dockerfile.slice(dockerfile.indexOf('AS runner'))

    expect(runnerStage).toMatch(/\bapk add --no-cache\b[^\n]*\bpostgresql16-client\b/)
  })

  it('does not expose Postgres on every host interface', () => {
    const compose = readRepoFile('docker-compose.yml')

    expect(compose).not.toContain('"5432:5432"')
    expect(compose).toContain('"127.0.0.1:${DB_HOST_PORT:-5432}:5432"')
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

  it('configures Dependabot for pnpm and GitHub Actions updates', () => {
    const dependabot = readRepoFile('.github/dependabot.yml')

    expect(dependabot).toContain('package-ecosystem: "npm"')
    expect(dependabot).toContain('directory: "/"')
    expect(dependabot).toContain('package-ecosystem: "github-actions"')
  })
})
