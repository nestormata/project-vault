import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXTENSION_API_VERSION } from '@project-vault/extension-api'

// Story 67.2: helpers for the real-process proof of the 67-1 fatal fault handler. They spawn the
// real `apps/api/src/main.ts` (same tsx launch as the e2e isolated stack) with a throwaway
// extension that leaks a fault on SIGUSR2. Nothing here reads or prints the environment.

export type FaultKind = 'emitter' | 'pool' | 'rejection'

export const FIXTURE_PACKAGE = 'pv-fault-fixture-67-2'
export const FIXTURE_MANIFEST_NAME = 'test.fault-leak-extension-67-2'
/** Appears in the leaked error's message; it must never reach the process output. */
export const FAULT_SENTINEL = 'FAULT-SENTINEL-67-2'
export const INFLIGHT_MARKER = 'FIXTURE_INFLIGHT_67_2'
// A wrapped /health: the vault guard lets it through while the vault is uninitialized.
export const SLOW_ROUTE = '/health'

const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const NODE_MODULES_DIR = join(API_DIR, 'node_modules')
const FIXTURE_DIR = join(NODE_MODULES_DIR, FIXTURE_PACKAGE)
const MAIN_PATH = join(API_DIR, 'src/main.ts')
const FIXTURE_PREFIX = 'pv-fault-fixture-'

function fixtureSource(): string {
  return `import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

const KIND = process.env.PV_FAULT_KIND
const SENTINEL = ${JSON.stringify(FAULT_SENTINEL)}
let markFaultSeen
const faultSeen = new Promise((done) => { markFaultSeen = done })
// Runs after the host's own listeners (they were installed first, in main()), so the host has
// already started app.close() when this resolves.
process.on('uncaughtException', () => markFaultSeen())
process.on('unhandledRejection', () => markFaultSeen())

function leakEmitter() {
  new EventEmitter().emit('error', new Error(SENTINEL))
}

function leakRejection() {
  Promise.reject(new Error(SENTINEL))
}

async function leakPool() {
  const pgUrl = import.meta.resolve('pg-boss')
  const { Pool, Client } = createRequire(pgUrl)('pg')
  const appName = 'pv-67-2-fault-pool'
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, application_name: appName })
  await pool.query('select 1')
  const killer = new Client({ connectionString: process.env.DATABASE_URL })
  await killer.connect()
  await killer.query('select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1', [appName])
  await killer.end()
}

const LEAKS = { emitter: leakEmitter, rejection: leakRejection, pool: leakPool }

process.on('SIGUSR2', () => LEAKS[KIND]())

const manifest = {
  name: ${JSON.stringify(FIXTURE_MANIFEST_NAME)},
  apiVersion: ${JSON.stringify(EXTENSION_API_VERSION)},
  capabilities: [],
  apiRoutes: {
    override: [{ method: 'GET', url: ${JSON.stringify(SLOW_ROUTE)}, mode: 'wrap' }],
  },
}

const hooksFactory = () => ({
  apiRoutes: {
    routes: {
      ${JSON.stringify(`GET ${SLOW_ROUTE}`)}: {
        handler: async (_req, _reply, next) => {
          process.stdout.write(${JSON.stringify(INFLIGHT_MARKER)} + '\\n')
          await faultSeen
          await new Promise((done) => setTimeout(done, 50))
          return next()
        },
      },
    },
  },
})

export default { manifest, hooksFactory }
`
}

/** Removes fixture directories left behind by a crashed earlier run. */
export function sweepStaleFixtures(): void {
  for (const entry of readdirSync(NODE_MODULES_DIR)) {
    if (entry.startsWith(FIXTURE_PREFIX)) {
      rmSync(join(NODE_MODULES_DIR, entry), { recursive: true, force: true })
    }
  }
}

export function writeFaultFixture(): void {
  sweepStaleFixtures()
  mkdirSync(FIXTURE_DIR, { recursive: true })
  writeFileSync(
    join(FIXTURE_DIR, 'package.json'),
    JSON.stringify({ name: FIXTURE_PACKAGE, version: '0.0.0', type: 'module', main: './index.mjs' })
  )
  writeFileSync(join(FIXTURE_DIR, 'index.mjs'), fixtureSource())
}

export function removeFaultFixture(): void {
  rmSync(FIXTURE_DIR, { recursive: true, force: true })
}

/** An OS-assigned free TCP port (bound and released; the child binds it right after). */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

export type ExitInfo = { code: number | null; signal: NodeJS.Signals | null }

export type ApiChild = {
  port: number
  process: ChildProcess
  lines: string[]
  exited: Promise<ExitInfo>
  /** Resolves with the first line (already seen or future) matching, rejects if the child exits first. */
  waitForLine: (matches: (line: string) => boolean, label: string) => Promise<string>
  /** Redacted tail for failure messages: log lines only, truncated. */
  tail: () => string
}

export async function startApiChild(kind: FaultKind): Promise<ApiChild> {
  const port = await freePort()
  // `--import tsx` runs main.ts in this very process (tsx/cli would add a relaying parent), so
  // signals and the exit code are the entrypoint's own.
  const child = spawn(process.execPath, ['--import', 'tsx', MAIN_PATH], {
    cwd: API_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      API_PORT: String(port),
      LOG_LEVEL: 'info',
      METRICS_BIND_HOST: '127.0.0.1',
      VAULT_EXTENSIONS_PACKAGE: FIXTURE_PACKAGE,
      PV_FAULT_KIND: kind,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })

  const lines: string[] = []
  const waiters: Array<{ matches: (line: string) => boolean; resolve: (line: string) => void }> = []
  const lineReader = () => {
    let pending = ''
    return (chunk: string) => {
      pending += chunk
      const parts = pending.split('\n')
      pending = parts.pop() ?? ''
      for (const line of parts) {
        lines.push(line)
        for (const waiter of [...waiters]) {
          if (waiter.matches(line)) {
            waiters.splice(waiters.indexOf(waiter), 1)
            waiter.resolve(line)
          }
        }
      }
    }
  }
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', lineReader())
  child.stderr?.on('data', lineReader())

  const exited = new Promise<ExitInfo>((done) => {
    child.once('exit', (code, signal) => done({ code, signal }))
  })

  const tail = () =>
    lines
      .slice(-15)
      .map((line) => line.slice(0, 300))
      .join('\n')
  const waitForLine = (matches: (line: string) => boolean, label: string) =>
    new Promise<string>((resolveLine, reject) => {
      const seen = lines.find(matches)
      if (seen !== undefined) {
        resolveLine(seen)
        return
      }
      waiters.push({ matches, resolve: resolveLine })
      void exited.then(({ code, signal }) =>
        reject(
          new Error(`child exited (code ${code}, signal ${signal}) before ${label}\n${tail()}`)
        )
      )
    })

  return { port, process: child, lines, exited, waitForLine, tail }
}

/** SIGKILLs the child's whole process group; a no-op once it is gone. */
export function killApiChild(child: ApiChild | undefined): void {
  const pid = child?.process.pid
  if (pid === undefined || child?.process.exitCode !== null) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // already gone
  }
}

export function parseJsonLine(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

export function hasEvent(line: string, eventType: string): boolean {
  return parseJsonLine(line)?.['eventType'] === eventType
}
