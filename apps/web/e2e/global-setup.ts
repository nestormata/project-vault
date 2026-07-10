import postgres from 'postgres'
import { execFileSync } from 'node:child_process'
import {
  buildMigrationInvocation,
  generateE2EVaultPassphrase,
} from '../src/lib/server/e2e-setup-security.js'
import { superuserDatabaseUrl } from './fixtures/db.js'

// AC-I3: global-setup.ts's job is readiness-polling + DB-reset + vault-init ONLY — it does NOT
// start the API/DB itself (unlike architecture.md's original illustrative comment). This story
// deliberately reuses `make docker-up`/`make bootstrap-docker` as the stack-startup mechanism;
// the stack must already be running before Playwright is invoked (see Makefile's `e2e: docker-up`
// target and the nightly.yml `e2e` job).

function apiBaseUrl(): string {
  const apiHostPort = process.env['API_HOST_PORT'] ?? '3000'
  return process.env['E2E_API_BASE_URL'] ?? `http://localhost:${apiHostPort}`
}

const NOT_RUNNING_HINT =
  'API not reachable — did you run `make docker-up` (or `make e2e`, which does this for you)?'

// Mirrors scripts/docker-smoke.sh's bounded-retry wait-for-ready pattern, in TypeScript.
async function waitForReady(
  url: string,
  label: string,
  attempts = 20,
  delayMs = 3000
): Promise<void> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) return
      lastError = new Error(`${label} responded with ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  throw new Error(`${NOT_RUNNING_HINT}\n(${label} never became ready: ${String(lastError)})`)
}

// Code review (10-1): superuserDatabaseUrl() defaults to postgresql://postgres:password@
// localhost:5432/project_vault — the exact same host/port/database name as a plain `make
// docker-up` dev stack (docker-compose.yml's own defaults). Without this guard, anyone who runs
// Playwright directly (`pnpm --filter @project-vault/web test:e2e`) against their ordinary local
// dev stack, instead of via `make e2e`, would have this function silently DROP their real dev
// database with no confirmation. `make e2e`/nightly.yml's `e2e` job both set
// E2E_CONFIRM_DB_RESET=true explicitly (see Makefile, .github/workflows/nightly.yml) as the
// opt-in signal that the target is understood to be disposable.
function assertResetIsSafe(): void {
  if (process.env['E2E_CONFIRM_DB_RESET'] === 'true') return
  throw new Error(
    'Refusing to reset the database: E2E_CONFIRM_DB_RESET is not set to "true".\n' +
      'This function drops and recreates the "public"/"drizzle" schemas, destroying all data at ' +
      `${superuserDatabaseUrl().replace(/:[^:@]*@/, ':***@')}.\n` +
      'Run via `make e2e` (which sets this safety flag for you), or, if you intend to run ' +
      'Playwright directly against a database you know is disposable, set both ' +
      'E2E_CONFIRM_DB_RESET=true and (if it is not your default dev stack) ' +
      'E2E_SUPERUSER_DATABASE_URL explicitly.'
  )
}

async function resetDatabase(): Promise<void> {
  // AC-I3: mirrors nightly.yml's flaky-test-repeat job's own schema-reset precedent — connect as
  // the superuser and drop+recreate public/drizzle so the run starts from zero orgs/users/vault
  // state, then re-run migrations, instead of whatever accumulated from prior local dev or a
  // prior E2E run.
  assertResetIsSafe()
  const sql = postgres(superuserDatabaseUrl(), { max: 1 })
  try {
    await sql.unsafe(
      'DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'
    )
  } finally {
    await sql.end({ timeout: 5 })
  }

  const migration = buildMigrationInvocation()
  execFileSync(migration.executable, migration.args, {
    cwd: new URL('../../..', import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: superuserDatabaseUrl() },
    stdio: 'inherit',
  })
}

async function initVault(): Promise<void> {
  // AC-I3: passphrase mode is the simplest init payload (no split-key file mounting). Requires
  // VAULT_ALLOW_REMOTE_INIT=true on the api container for the E2E run only (see Makefile's `e2e`
  // target / nightly.yml's `e2e` job — never set on the base docker-compose.yml's api service).
  const response = await fetch(`${apiBaseUrl()}/api/v1/vault/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kmsType: 'passphrase',
      passphrase: generateE2EVaultPassphrase(),
    }),
  })
  if (!response.ok && response.status !== 409) {
    const body = await response.text()
    throw new Error(`vault/init failed (${response.status}): ${body}`)
  }
}

export default async function globalSetup(): Promise<void> {
  const base = apiBaseUrl()
  // AC-I3 polls /health then /ready, but /ready itself reports 503 "uninitialized" until this
  // very function's own initVault() call runs (confirmed against apps/api/src/routes/health.ts's
  // handler) — so /ready can only be meaningfully checked AFTER vault init, not before it. /health
  // alone (basic API/DB liveness, no vault-state dependency) is the correct pre-reset readiness
  // gate; /ready is re-checked at the end to confirm initialization actually took effect before
  // any spec runs.
  await waitForReady(`${base}/health`, 'API /health')
  await resetDatabase()
  await initVault()
  await waitForReady(`${base}/ready`, 'API /ready (post vault-init)')
}
