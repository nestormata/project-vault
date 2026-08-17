import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import postgres from 'postgres'
import { expect, type APIRequestContext } from '@playwright/test'
import { superuserDatabaseUrl } from './db.js'
import { pollUntilOk } from './poll-until-ready.js'

/**
 * Shared plumbing for "isolated stack" E2E fixtures — self-contained, non-Docker
 * `apps/api`+`apps/web` process pairs spawned directly against a freshly-created, dedicated
 * Postgres database on the same server the shared E2E docker stack uses. Used by Story 23.2's
 * J19 (`isolated-envelope-stack.ts`) and Story 23.3's J20 (`isolated-capability-gate-stack.ts`),
 * which both need this exact shape because a host process can only load ONE
 * `VAULT_EXTENSIONS_PACKAGE` at a time and the shared stack's slot is already spoken for.
 */

export const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const require = createRequire(import.meta.url)

export function dbHostPort(): string {
  return process.env['DB_HOST_PORT'] ?? '5432'
}

export function tsxExecutable(): { executable: string; tsxCliPath: string } {
  return { executable: process.execPath, tsxCliPath: require.resolve('tsx/cli') }
}

/**
 * Creates a dedicated, freshly-migrated database for a journey, isolated from the shared E2E
 * database every other journey resets/uses. Postgres roles are cluster-wide (not per-database),
 * so `vault_app`/`vault_admin` already exist on this server from the primary database's own
 * bootstrap — this only needs to grant them access to the new database name, working around
 * migration 0001/0071's two `GRANT ... ON DATABASE project_vault` statements being hardcoded to
 * that literal name.
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

export async function waitForHttp(url: string, attempts = 40, delayMs = 500): Promise<void> {
  await pollUntilOk(url, {
    attempts,
    delayMs,
    onExhausted: (lastError) => new Error(`Timed out waiting for ${url}: ${String(lastError)}`),
  })
}

/**
 * Negative pid signals the whole process group (see the `detached: true` spawn option on both
 * spawn helpers below) — belt-and-braces against tsx (or a future version of it) spawning a real
 * child rather than exec-ing in-process, which would otherwise survive a plain `child.kill()`.
 */
export async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  const pid = child.pid
  const killGroup = (signal: NodeJS.Signals) => {
    if (!pid) return
    try {
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

/** Pipes a spawned child's stdout/stderr to the console with a `[label:port]` prefix — a
 * diagnostic aid for when a journey fails locally. Shared by both spawn helpers below. */
function pipeChildDiagnostics(child: ChildProcess, label: string, port: number): void {
  // eslint-disable-next-line no-console -- diagnostic aid when this journey fails locally
  child.stdout?.on('data', (chunk) => console.log(`[${label}:${port}]`, String(chunk)))
  child.stderr?.on('data', (chunk) => {
    // eslint-disable-next-line no-console -- diagnostic aid when this journey fails locally
    console.error(`[${label}:${port}]`, String(chunk))
  })
}

export type SpawnIsolatedApiOptions = {
  port: number
  dbName: string
  webPort: number
  /** Console-log prefix, e.g. `api-envelope` / `api-capgate`. */
  logLabel: string
  /** Env var name a developer can set locally to raise log verbosity for this journey only. */
  logLevelEnvVar: string
  /** Fixture-specific env vars layered on top of the common isolated-API env (e.g. which
   *  `VAULT_EXTENSIONS_PACKAGE` to load). */
  extraEnv?: Record<string, string>
}

/** Boots a real `apps/api` process (tsx, not Docker) against an isolated database and waits for
 * `/health` to respond. Returns the raw child process — callers wrap it in their own
 * fixture-specific handle type. */
export async function spawnIsolatedApiProcess(
  options: SpawnIsolatedApiOptions
): Promise<ChildProcess> {
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
      CORS_ALLOWED_ORIGINS: `http://localhost:${options.webPort}`,
      METRICS_BIND_HOST: '127.0.0.1',
      METRICS_PORT: String(options.port + 1000),
      VAULT_ALLOW_REMOTE_INIT: 'true',
      AUTH_RATE_LIMIT_MAX: '100000',
      AUTH_REGISTER_RATE_LIMIT_MAX: '1000',
      LOG_LEVEL: process.env[options.logLevelEnvVar] ?? 'silent',
      ...options.extraEnv,
    },
    stdio: 'pipe',
    // tsx's CLI itself execs the target file in-process (no extra child) under normal use, but
    // detaching into its own process group is a cheap, robust guard either way — stopProcess()
    // signals the whole group, not just this one pid, so a restart can never accidentally
    // observe a stale process that silently kept holding the port.
    detached: true,
  })
  pipeChildDiagnostics(child, options.logLabel, options.port)

  await waitForHttp(`http://localhost:${options.port}/health`)
  return child
}

/**
 * Initializes the vault on a freshly-booted isolated API process. `POST /api/v1/vault/init` is
 * vault-guard-allowlisted, and `VAULT_ALLOW_REMOTE_INIT=true` (set by `spawnIsolatedApiProcess()`
 * via its caller's env) permits calling it without a bootstrap token — mirrors
 * `global-setup.ts`'s own `initVault()` exactly. Shared by J19 (`isolated-envelope-stack.ts`) and
 * J20 (`isolated-capability-gate-stack.ts`), which both need this exact call.
 */
export async function initIsolatedVault(apiPort: number, passphrase: string): Promise<void> {
  const init = await fetch(`http://localhost:${apiPort}/api/v1/vault/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kmsType: 'passphrase', passphrase }),
  })
  if (!init.ok && init.status !== 409) {
    throw new Error(`vault/init failed (${init.status}): ${await init.text()}`)
  }
}

/**
 * Registers an org owner, logs in, and marks onboarding complete against an isolated API-only
 * process reached via an absolute base URL (as opposed to `auth.ts`'s `registerAndLoginViaApi`,
 * which uses a Playwright `BrowserContext`'s configured baseURL/cookie jar — the isolated-stack
 * journeys spawn their own API process on a one-off port with no web process or baseURL). Shared
 * by J21 (Story 22.1) and J22 (Story 22.2), whose per-org audit-quota/rate journeys are otherwise
 * identical apart from which axis (storage vs. throughput) they configure and assert on.
 */
export async function registerAndLoginIsolated(
  request: APIRequestContext,
  apiBase: string,
  opts: { email: string; password: string; orgName: string }
): Promise<{ userId: string; orgId: string }> {
  const register = await request.post(`${apiBase}/api/v1/auth/register`, {
    data: { email: opts.email, password: opts.password, orgName: opts.orgName },
  })
  expect(register.ok(), await register.text()).toBeTruthy()

  const login = await request.post(`${apiBase}/api/v1/auth/login`, {
    data: { email: opts.email, password: opts.password },
  })
  expect(login.ok(), await login.text()).toBeTruthy()
  const body = (await login.json()) as { data: { userId: string; orgId: string } }

  const onboarding = await request.post(`${apiBase}/api/v1/users/me/onboarding`, {
    data: { completed: true },
  })
  expect(onboarding.ok(), await onboarding.text()).toBeTruthy()

  return body.data
}

/** Standard `afterAll` teardown for an isolated API+web process pair: stops both processes (if
 * started) then drops the dedicated database. Shared by J19 and J20's `afterAll` hooks. */
export async function teardownIsolatedStack(handles: {
  webHandle: WebHandle | undefined
  apiHandle: { process: ChildProcess } | undefined
  dbName: string
}): Promise<void> {
  if (handles.webHandle) await stopProcess(handles.webHandle.process)
  if (handles.apiHandle) await stopProcess(handles.apiHandle.process)
  await dropIsolatedDatabase(handles.dbName)
}

export type WebHandle = { process: ChildProcess; port: number }

/** Boots a real `apps/web` Vite dev server pointed at the isolated API via `API_BASE_URL` — a
 * genuinely separate origin from the shared E2E web app, so Playwright's `browser.newPage()`
 * navigating here never touches the shared stack. */
export async function spawnIsolatedWebProcess(options: {
  port: number
  apiPort: number
  /** Console-log prefix, e.g. `web-envelope` / `web-capgate`. */
  logLabel: string
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
  pipeChildDiagnostics(child, options.logLabel, options.port)

  await waitForHttp(`http://localhost:${options.port}/login`)
  return { process: child, port: options.port }
}
