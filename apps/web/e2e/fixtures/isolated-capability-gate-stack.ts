import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import postgres from 'postgres'
import { superuserDatabaseUrl } from './db.js'
import { pollUntilOk } from './poll-until-ready.js'

/**
 * Story 23.3 J20 — a self-contained, isolated API+web process pair for this story's own two E2E
 * journeys (Dana: no gate configured; Priya: gated via `mock-capability-gate-extension`),
 * deliberately NOT sharing the main E2E docker stack j1-j18/j6 run against — that stack already
 * dedicates its one `VAULT_EXTENSIONS_PACKAGE` slot to `@project-vault/mock-sso-extension`, and a
 * host process can only load ONE extension package at a time. Mirrors
 * `isolated-envelope-stack.ts`'s (Story 23.2 J19) structure closely; the two differ only in which
 * fixture package is loaded and which env vars that fixture needs.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const require = createRequire(import.meta.url)

function dbHostPort(): string {
  return process.env['DB_HOST_PORT'] ?? '5432'
}

function tsxExecutable(): { executable: string; tsxCliPath: string } {
  return { executable: process.execPath, tsxCliPath: require.resolve('tsx/cli') }
}

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
  webPort: number
  extensionPackage?: string
  extraPermittedOrgId?: string
}

/**
 * Boots a real `apps/api` process (tsx, not Docker) against an isolated database. Pass
 * `extensionPackage: undefined` for Dana's journey (no gate configured — the byte-identical
 * no-op path, AC-5) or `'@project-vault/mock-capability-gate-extension'` for Priya's (gated).
 * `extraPermittedOrgId` is J20's "simulated upgrade" escape hatch — see the fixture's own doc
 * comment on `MOCK_CAPABILITY_GATE_EXTRA_PERMITTED_ORG_ID`.
 */
export async function startCapabilityGateApi(options: {
  port: number
  dbName: string
  webPort: number
  extensionPackage?: string
  extraPermittedOrgId?: string
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
      CORS_ALLOWED_ORIGINS: `http://localhost:${options.webPort}`,
      METRICS_BIND_HOST: '127.0.0.1',
      METRICS_PORT: String(options.port + 1000),
      ...(options.extensionPackage ? { VAULT_EXTENSIONS_PACKAGE: options.extensionPackage } : {}),
      ...(options.extraPermittedOrgId
        ? { MOCK_CAPABILITY_GATE_EXTRA_PERMITTED_ORG_ID: options.extraPermittedOrgId }
        : {}),
      VAULT_ALLOW_REMOTE_INIT: 'true',
      AUTH_RATE_LIMIT_MAX: '100000',
      AUTH_REGISTER_RATE_LIMIT_MAX: '1000',
      LOG_LEVEL: process.env['J20_DEBUG_LOG_LEVEL'] ?? 'silent',
    },
    stdio: 'pipe',
    detached: true,
  })
  // eslint-disable-next-line no-console -- diagnostic aid when this journey fails locally
  child.stdout?.on('data', (chunk) => console.log(`[api-capgate:${options.port}]`, String(chunk)))
  child.stderr?.on('data', (chunk) => {
    // eslint-disable-next-line no-console -- diagnostic aid when this journey fails locally
    console.error(`[api-capgate:${options.port}]`, String(chunk))
  })

  await waitForHttp(`http://localhost:${options.port}/health`)

  return {
    process: child,
    port: options.port,
    dbName: options.dbName,
    webPort: options.webPort,
    extensionPackage: options.extensionPackage,
    extraPermittedOrgId: options.extraPermittedOrgId,
  }
}

/** Restarts the API process against the SAME database, optionally with a different
 * `extraPermittedOrgId` — the only way a boot-time-read value can change, mirroring an operator's
 * deliberate restart exactly (same shape as Story 23.2 J19's `restartEnvelopeApi`). */
export async function restartCapabilityGateApi(
  handle: ApiHandle,
  overrides: { extraPermittedOrgId?: string } = {}
): Promise<ApiHandle> {
  await stopProcess(handle.process)
  return startCapabilityGateApi({
    port: handle.port,
    dbName: handle.dbName,
    webPort: handle.webPort,
    extensionPackage: handle.extensionPackage,
    extraPermittedOrgId: overrides.extraPermittedOrgId ?? handle.extraPermittedOrgId,
  })
}

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

export type WebHandle = { process: ChildProcess; port: number }

export async function startCapabilityGateWeb(options: {
  port: number
  apiPort: number
}): Promise<WebHandle> {
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
  child.stdout?.on('data', (chunk) => console.log(`[web-capgate:${options.port}]`, String(chunk)))
  child.stderr?.on('data', (chunk) => {
    // eslint-disable-next-line no-console -- diagnostic aid when this journey fails locally
    console.error(`[web-capgate:${options.port}]`, String(chunk))
  })

  await waitForHttp(`http://localhost:${options.port}/login`)

  return { process: child, port: options.port }
}
