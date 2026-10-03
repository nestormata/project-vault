import { pathToFileURL } from 'node:url'
import type { AppOptions } from '../app.js'
import type { FastifyApp } from '../lib/fastify-app.js'
import type { ExtensionState } from '../extensions/loader.js'
import { PUBLIC_ROUTE_EXEMPTIONS, RUNTIME_ROUTE_CLASSIFICATIONS } from '../lib/route-exemptions.js'
import {
  ClassificationInputError,
  classifyRoutes,
  formatAuditReport,
  loadClassificationsFile,
  mergeClassifications,
  type AuditReport,
  type ClassificationEntry,
} from '../extensions/api-routes/route-audit.js'
import type { ObservedRoute } from '../extensions/api-routes/route-observer.js'
import { prepareSpecGenerationEnv } from './spec-env.js'

/**
 * Story 68.14 AC-2 (d) — the runtime route audit CLI and its programmatic core.
 *
 *   pnpm --filter @project-vault/api route-audit:runtime [--extension <pkg>] [--classifications <file>]
 *
 * Boots the real `createApp()` (no `listen`, no request: `app.ready()` only) with a root `onRoute`
 * collector, then proves every route is `secureRoute`-built or classified (PV's table plus the
 * optional extension table). DB-free like `generate-spec`: the loader's DB steps are stubbed.
 * Exit codes: 0 pass; 1 the audit failed or the extension did not load; 2 a usage or input error.
 * The report holds no absolute path and no env value, so CI logs are diff-stable.
 */

export class AuditUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuditUsageError'
  }
}

export class AuditLoadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuditLoadError'
  }
}

export type AuditArgs = { extension?: string; classifications?: string }

export const USAGE = 'usage: route-audit:runtime [--extension <package>] [--classifications <file>]'

// A bare npm package specifier: `name` or `@scope/name`, each segment a lowercase npm name part.
// Never a path, URL or version.
const PACKAGE_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u

function isBarePackageSpecifier(value: string): boolean {
  const segments = value.startsWith('@') ? value.slice(1).split('/') : [value]
  const expected = value.startsWith('@') ? 2 : 1
  return (
    segments.length === expected &&
    segments.every((segment) => PACKAGE_SEGMENT_PATTERN.test(segment))
  )
}

const FLAGS = new Map<string, keyof AuditArgs>([
  ['--extension', 'extension'],
  ['--classifications', 'classifications'],
])

function flagPairs(argv: readonly string[]): Array<[string, string | undefined]> {
  return Array.from({ length: Math.ceil(argv.length / 2) }, (_unused, pair) => {
    const [flag, value] = argv.slice(pair * 2, pair * 2 + 2)
    return [flag ?? '', value]
  })
}

export function parseAuditArgs(argv: readonly string[]): AuditArgs {
  const parsed = new Map<keyof AuditArgs, string>()
  for (const [flag, value] of flagPairs(argv)) {
    const name = FLAGS.get(flag)
    if (!name) throw new AuditUsageError(`unknown argument "${flag}"`)
    if (value === undefined || value === '' || FLAGS.has(value)) {
      throw new AuditUsageError(`${flag} needs a value`)
    }
    if (parsed.has(name)) throw new AuditUsageError(`${flag} was given more than once`)
    parsed.set(name, value)
  }
  const extension = parsed.get('extension')
  if (extension !== undefined && !isBarePackageSpecifier(extension)) {
    throw new AuditUsageError('--extension must be a bare package specifier (not a path or URL)')
  }
  return { extension, classifications: parsed.get('classifications') }
}

export function pvClassifications(): ClassificationEntry[] {
  return [
    ...PUBLIC_ROUTE_EXEMPTIONS.map(({ route, reason }) => ({ route, reason })),
    ...RUNTIME_ROUTE_CLASSIFICATIONS,
  ]
}

export type AuditDeps = {
  createApp: (options: AppOptions) => Promise<FastifyApp>
  getExtensionStatus: () => ExtensionState
  /** The loader's injection seams; the CLI stubs the DB-touching ones. */
  loaderDeps?: NonNullable<AppOptions['extension']>['loaderDeps']
  /** PV's classification table; tests substitute a mutated copy. Defaults to the real one. */
  pvEntries?: readonly ClassificationEntry[]
}

/** The loader's DB-free stubs: no org to enumerate, no audit row to write. */
export const DB_FREE_LOADER_DEPS: NonNullable<AuditDeps['loaderDeps']> = {
  listOrgIds: async () => [],
  auditWriter: async () => undefined,
}

/** Boots the app, collects every route and classifies it. Never sends a request. */
export async function runRouteAudit(args: AuditArgs, deps: AuditDeps): Promise<AuditReport> {
  const extensionEntries = args.classifications ? loadClassificationsFile(args.classifications) : []
  const table = mergeClassifications(deps.pvEntries ?? pvClassifications(), extensionEntries)
  const routes: ObservedRoute[] = []
  const app = await deps.createApp({
    logger: false,
    routeObserver: (route) => routes.push(route),
    ...(args.extension
      ? {
          extension: {
            packageName: args.extension,
            loaderDeps: deps.loaderDeps ?? DB_FREE_LOADER_DEPS,
          },
        }
      : {}),
  })
  try {
    await app.ready()
    const status = deps.getExtensionStatus()
    if (args.extension && status.status !== 'loaded') {
      const reason = status.status === 'load_failed' ? status.reason : status.status
      throw new AuditLoadError(`extension ${args.extension} did not load: ${reason}`)
    }
  } finally {
    await app.close()
  }
  return classifyRoutes(routes, table)
}

type Io = { stdout: (text: string) => void; stderr: (text: string) => void }

/** Maps an audit run to its exit code and output. */
export async function runCli(
  argv: readonly string[],
  deps: AuditDeps,
  io: Io = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  }
): Promise<number> {
  try {
    const report = await runRouteAudit(parseAuditArgs(argv), deps)
    io.stdout(`${formatAuditReport(report)}\n`)
    return report.ok ? 0 : 1
  } catch (error) {
    if (error instanceof AuditUsageError || error instanceof ClassificationInputError) {
      io.stderr(`${error.message}\n${USAGE}\n`)
      return 2
    }
    io.stderr(`${error instanceof Error ? error.message : 'route audit failed'}\n`)
    return 1
  }
}

async function main(): Promise<void> {
  // Usage errors are answered before anything is imported or booted.
  try {
    parseAuditArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n${USAGE}\n`)
    process.exit(2)
  }
  // Must run before app.js (and config/env.ts) is imported: the no-extension run must not see a
  // developer shell's extension settings (the same function generate-spec uses). Swagger UI is
  // switched on so its routes are always audited, whatever the shell's NODE_ENV.
  process.env.DATABASE_URL ??= 'postgresql://vault_app@localhost:5432/project_vault'
  process.env.ENABLE_API_DOCS = 'true'
  prepareSpecGenerationEnv(process.env)
  const { createApp } = await import('../app.js')
  const { getExtensionStatus } = await import('../extensions/loader.js')
  const code = await runCli(process.argv.slice(2), { createApp, getExtensionStatus })
  // Some Fastify plugins retain event-loop handles after close under Node 24 (see generate-spec).
  process.exit(code)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main()
}
