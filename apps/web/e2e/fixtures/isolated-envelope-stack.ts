import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import postgres from 'postgres'
import { superuserDatabaseUrl } from './db.js'
import { pollUntilOk } from './poll-until-ready.js'

/**
 * Story 23.2 — a self-contained, isolated API+web process pair for this story's own E2E journey
 * (j19), deliberately NOT sharing the main E2E docker stack j1-j18/j6 run against. That shared
 * stack already dedicates its one `VAULT_EXTENSIONS_PACKAGE` slot to `@project-vault/mock-sso-
 * extension` (see docker-compose.e2e.yml) — a host process can only load ONE extension package,
 * and switching the shared stack to this story's own fixture would silently break j6's own tests.
 *
 * More fundamentally, this story's whole point (AC-4's "resolved once at boot, applied only at
 * the next restart") cannot be exercised against a long-lived shared server that Playwright's
 * global-setup never restarts mid-suite. This harness spawns real `apps/api`/`apps/web` child
 * processes directly (not Docker) against a dedicated, freshly-created Postgres database on the
 * SAME running Postgres server the rest of E2E uses, so this journey can genuinely kill and
 * respawn the API process between assertions — the one thing that actually matters here.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const require = createRequire(import.meta.url)

function dbHostPort(): string {
  return process.env['DB_HOST_PORT'] ?? '5432'
}

function tsxExecutable(): { executable: string; tsxCliPath: string } {
  return { executable: process.execPath, tsxCliPath: require.resolve('tsx/cli') }
}

/**
 * Creates a dedicated, freshly-migrated database for this journey, isolated from the shared E2E
 * database every other journey resets/uses. Postgres roles are cluster-wide (not per-database),
 * so `vault_app`/`vault_admin` already exist on this server from the primary database's own
 * bootstrap — this only needs to grant them access to the new database name, working around
 * migration 0001/0071's two `GRANT ... ON DATABASE project_vault` statements being hardcoded to
 * that literal name (a real, narrow gap this story's investigation surfaced, not a workaround for
 * anything this story broke).
 */
export async function createIsolatedDatabase(dbName: string): Promise<void> {
  const admin = postgres(superuserDatabaseUrl(), { max: 1 })
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
    await admin.unsafe(`CREATE DATABASE ${dbName}`)
  } finally {
    await admin.end({ timeout: 5 })
  }

  const { executable, tsxCliPath } = tsxExecutable()
  const migrationScript = fileURLToPath(
    new URL('../../../../packages/db/src/scripts/guarded-migrate.ts', import.meta.url)
  )
  const isolatedSuperuserUrl = superuserDatabaseUrl().replace(/\/[^/]+$/, `/${dbName}`)
  execFileSync(executable, [tsxCliPath, migrationScript], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: isolatedSuperuserUrl },
    stdio: 'inherit',
  })

  const db = postgres(isolatedSuperuserUrl, { max: 1 })
  try {
    await db.unsafe(`GRANT CONNECT, CREATE ON DATABASE ${dbName} TO vault_app`)
    await db.unsafe(`GRANT CONNECT ON DATABASE ${dbName} TO vault_admin`)
  } finally {
    await db.end({ timeout: 5 })
  }
}

export async function dropIsolatedDatabase(dbName: string): Promise<void> {
  const admin = postgres(superuserDatabaseUrl(), { max: 1 })
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
  } finally {
    await admin.end({ timeout: 5 })
  }
}

async function waitForHttp(url: string, attempts = 40, delayMs = 500): Promise<void> {
  await pollUntilOk(url, {
    attempts,
    delayMs,
    onExhausted: (lastError) => new Error(`Timed out waiting for ${url}: ${String(lastError)}`),
  })
}

export type ApiHandle = {
  process: ChildProcess
  port: number
  dbName: string
  envAudience: string
  webPort: number
}

/** Boots a real `apps/api` process (tsx, not Docker) against the isolated database, with the
 * mock-envelope-extension fixture loaded. `vaultGuardEnabled: true` is main.ts's own hardcoded
 * default (unchanged here) — POST /register, /login, /refresh are vault-guard-allowlisted (see
 * apps/api/src/plugins/vault-guard.ts), which is why this harness never needs to call
 * `/vault/init` at all: this journey only exercises those three routes plus the SSO
 * start/callback pair, and the latter two are deliberately exempted too (see below). */
export async function startEnvelopeApi(options: {
  port: number
  dbName: string
  envAudience: string
  webPort: number
}): Promise<ApiHandle> {
  const dbUrl = `postgresql://vault_app:dev-only-change-in-prod@localhost:${dbHostPort()}/${options.dbName}`
  const adminUrl = `postgresql://vault_admin:password@localhost:${dbHostPort()}/${options.dbName}`
  const { executable, tsxCliPath } = tsxExecutable()
  const mainPath = fileURLToPath(new URL('../../../api/src/main.ts', import.meta.url))

  const child = spawn(executable, [tsxCliPath, mainPath], {
    cwd: `${REPO_ROOT}/apps/api`,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: dbUrl,
      ADMIN_DATABASE_URL: adminUrl,
      API_PORT: String(options.port),
      // The isolated web-envelope process's proxy (apps/web/src/routes/api/v1/[...path]/+server.ts)
      // forwards the browser's Origin header straight through — without this, the default
      // CORS_ALLOWED_ORIGINS (http://localhost:5173) rejects every request from this journey's
      // own web origin.
      CORS_ALLOWED_ORIGINS: `http://localhost:${options.webPort}`,
      METRICS_BIND_HOST: '127.0.0.1',
      METRICS_PORT: String(options.port + 1000),
      VAULT_EXTENSIONS_PACKAGE: '@project-vault/mock-envelope-extension',
      MOCK_ENVELOPE_EXPECTED_AUDIENCE: options.envAudience,
      VAULT_ALLOW_REMOTE_INIT: 'true',
      AUTH_RATE_LIMIT_MAX: '100000',
      AUTH_REGISTER_RATE_LIMIT_MAX: '1000',
      LOG_LEVEL: process.env['J19_DEBUG_LOG_LEVEL'] ?? 'silent',
    },
    stdio: 'pipe',
    // tsx's CLI itself execs the target file in-process (no extra child) under normal use, but
    // detaching into its own process group is a cheap, robust guard either way — stopProcess()
    // below signals the whole group, not just this one pid, so a restart can never accidentally
    // observe a stale process that silently kept holding the port.
    detached: true,
  })
  // eslint-disable-next-line no-console -- diagnostic aid when this journey fails locally
  child.stdout?.on('data', (chunk) => console.log(`[api-envelope:${options.port}]`, String(chunk)))
  child.stderr?.on('data', (chunk) => {
    // eslint-disable-next-line no-console -- diagnostic aid when this journey fails locally
    console.error(`[api-envelope:${options.port}]`, String(chunk))
  })

  await waitForHttp(`http://localhost:${options.port}/health`)

  return {
    process: child,
    port: options.port,
    dbName: options.dbName,
    envAudience: options.envAudience,
    webPort: options.webPort,
  }
}

export async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  const pid = child.pid
  const killGroup = (signal: NodeJS.Signals) => {
    if (!pid) return
    try {
      // Negative pid signals the whole process group (see the `detached: true` spawn option
      // above) — belt-and-braces against tsx (or a future version of it) spawning a real child
      // rather than exec-ing in-process, which would otherwise survive a plain child.kill().
      process.kill(-pid, signal)
    } catch {
      // ESRCH: the group is already gone — fine, that is the goal.
    }
  }

  killGroup('SIGTERM')
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    setTimeout(resolve, 5000)
  })
  if (child.exitCode === null) {
    killGroup('SIGKILL')
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
      setTimeout(resolve, 3000)
    })
  }
}

/** AC-4: restarts the API process against the SAME database — the one and only way the
 * boot-resolved policy can change, mirroring an operator's deliberate restart exactly. */
export async function restartEnvelopeApi(handle: ApiHandle): Promise<ApiHandle> {
  await stopProcess(handle.process)
  return startEnvelopeApi({
    port: handle.port,
    dbName: handle.dbName,
    envAudience: handle.envAudience,
    webPort: handle.webPort,
  })
}

export type WebHandle = { process: ChildProcess; port: number }

/** Boots a real `apps/web` Vite dev server pointed at the isolated API via `API_BASE_URL` — a
 * genuinely separate origin from the shared E2E web app, so Playwright's `browser.newPage()`
 * navigating here never touches the shared stack. */
export async function startEnvelopeWeb(options: {
  port: number
  apiPort: number
}): Promise<WebHandle> {
  // The pnpm-workspace-installed vite CLI binary — `require.resolve('vite/bin/vite.js')` fails
  // because vite's own package.json `exports` map does not expose that subpath.
  const viteBin = fileURLToPath(new URL('../../node_modules/.bin/vite', import.meta.url))
  const child = spawn(viteBin, ['dev', '--port', String(options.port), '--strictPort'], {
    cwd: `${REPO_ROOT}/apps/web`,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      API_BASE_URL: `http://localhost:${options.apiPort}`,
    },
    stdio: 'pipe',
    detached: true,
  })
  // eslint-disable-next-line no-console -- diagnostic aid when this journey fails locally
  child.stdout?.on('data', (chunk) => console.log(`[web-envelope:${options.port}]`, String(chunk)))
  child.stderr?.on('data', (chunk) => {
    // eslint-disable-next-line no-console -- diagnostic aid when this journey fails locally
    console.error(`[web-envelope:${options.port}]`, String(chunk))
  })

  await waitForHttp(`http://localhost:${options.port}/login`)

  return { process: child, port: options.port }
}
