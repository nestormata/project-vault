// Story 60.1 AC5 — the first `docker compose config`-based test in this repository (confirmed by
// story creation: no existing test/script ran `docker compose config` before this). Guards
// against a future edit to docker-compose.yml silently dropping the web service's
// CORS_ALLOWED_ORIGINS key (Finding F1's regression: apps/web's own CORS check was always-false
// because that key never reached its process).
//
// `docker compose config` only renders/merges YAML — it needs the Docker CLI but NOT a running
// daemon (confirmed directly in this project's cloud dev environment: `docker ps` fails with no
// daemon socket while `docker compose config --format json` still exits 0). If the CLI itself is
// genuinely absent (not just a daemon), this suite skips with the real reason logged rather than
// failing the whole run — see the `describeOrSkip` guard below.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const repoRoot = resolve(process.cwd())
const composeFile = join(repoRoot, 'docker-compose.yml')

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/** Elicitation finding (Boundary & Edge Case Sweep, integrated into AC5) — Compose auto-loads a
 * project-root `.env` if present, which would make a naive default-value assertion flaky
 * depending on the caller's ambient `.env`. This creates a fresh, empty, test-owned `--env-file`
 * so the rendered defaults are deterministic in every environment, regardless of what the caller's
 * own `.env` (if any) contains. */
function emptyEnvFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pv-compose-config-'))
  tempDirs.push(dir)
  const path = join(dir, 'empty.env')
  writeFileSync(path, '')
  return path
}

function renderComposeConfig(file: string, envFile: string): Record<string, unknown> {
  const stdout = execFileSync(
    'docker',
    ['compose', '-f', file, '--env-file', envFile, 'config', '--format', 'json'],
    { cwd: repoRoot, encoding: 'utf8' }
  )
  return JSON.parse(stdout) as Record<string, unknown>
}

function dockerComposeAvailable(): boolean {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const hasDockerCompose = dockerComposeAvailable()
const describeOrSkip = hasDockerCompose ? describe : describe.skip

if (!hasDockerCompose) {
  // eslint-disable-next-line no-console
  console.warn(
    '[check-compose-config] SKIPPED: Docker CLI/Compose plugin not available in this ' +
      'environment — see Story 60.1 Dev Notes.'
  )
}

describeOrSkip('docker compose config — web service CORS_ALLOWED_ORIGINS (Story 60.1 AC5)', () => {
  it('renders a CORS_ALLOWED_ORIGINS key on the web service, unconditionally', () => {
    const envFile = emptyEnvFile()
    const rendered = renderComposeConfig(composeFile, envFile)
    const services = rendered['services'] as Record<
      string,
      { environment?: Record<string, string> }
    >

    expect(services['web']?.environment).toHaveProperty('CORS_ALLOWED_ORIGINS')
  })

  it('defaults web.environment.CORS_ALLOWED_ORIGINS to the same value as api, under an isolated empty env-file', () => {
    const envFile = emptyEnvFile()
    const rendered = renderComposeConfig(composeFile, envFile)
    const services = rendered['services'] as Record<
      string,
      { environment?: Record<string, string> }
    >

    expect(services['web']?.environment?.['CORS_ALLOWED_ORIGINS']).toBe('http://localhost:5173')
    expect(services['web']?.environment?.['CORS_ALLOWED_ORIGINS']).toBe(
      services['api']?.environment?.['CORS_ALLOWED_ORIGINS']
    )
  })

  // Failure/regression example (AC5): a copy of docker-compose.yml with the web service's
  // CORS_ALLOWED_ORIGINS line removed must fail this assertion, naming the missing key — proving
  // the test actually guards against the regression it exists to catch, not just passing today.
  it('fails the key-presence assertion against a docker-compose.yml missing the web CORS_ALLOWED_ORIGINS line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pv-compose-config-regressed-'))
    tempDirs.push(dir)
    const regressedFile = join(dir, 'docker-compose.yml')
    const original = execFileSync('cat', [composeFile], { encoding: 'utf8' })
    const regressed = original.replace(
      /\n\s*CORS_ALLOWED_ORIGINS: \$\{PUBLIC_WEB_ORIGIN:-http:\/\/localhost:\$\{WEB_HOST_PORT:-5173\}\}\n(\s*ports:\n\s*- '\$\{WEB_HOST_PORT)/,
      '\n$1'
    )
    // Guard the fixture itself: if the replace didn't match, this test would pass for the wrong
    // reason (a no-op edit), so fail loudly here instead.
    expect(regressed).not.toBe(original)
    writeFileSync(regressedFile, regressed)

    const envFile = emptyEnvFile()
    const rendered = renderComposeConfig(regressedFile, envFile)
    const services = rendered['services'] as Record<
      string,
      { environment?: Record<string, string> }
    >

    expect(services['web']?.environment).not.toHaveProperty('CORS_ALLOWED_ORIGINS')
  })
})
