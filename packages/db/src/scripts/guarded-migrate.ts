#!/usr/bin/env tsx
/**
 * Story 9.3 D1/D2: replaces the raw `drizzle-kit migrate` behind `db:migrate` with a guard that
 * refuses to apply any pending migration containing a destructive operation (AC-3) unless the
 * operator explicitly passes `--allow-destructive`. `docker-compose.yml`'s one-shot `migrate`
 * service already runs this script by its package.json name (`pnpm --filter @project-vault/db
 * db:migrate`) — swapping the implementation behind that name required zero Compose changes.
 *
 * Pending-migration detection mirrors drizzle-kit's own algorithm exactly (see
 * `drizzle-orm/pg-core/dialect.js`'s `migrate()`): read the most recently applied migration's
 * `created_at` from `drizzle.__drizzle_migrations`, then treat every local migration whose
 * journal `when` timestamp is newer as pending. This script does not maintain its own
 * bookkeeping table — it reads the same state drizzle-kit itself consults.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { pgTlsOptions } from '../pg-tls.js'
import { OperationalEvent } from '@project-vault/shared'
import {
  findDestructiveStatements,
  KNOWN_REVIEWED_DESTRUCTIVE_MIGRATIONS,
} from '../lib/migration-safety.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const __filename = fileURLToPath(import.meta.url)

export type LocalMigration = { tag: string; sql: string; folderMillis: number }
export type DestructiveScanResult = { tag: string; findings: string[] }
export type MigrationAction = 'refuse' | 'proceed'

type JournalEntry = { idx: number; when: number; tag: string }
type Journal = { entries: JournalEntry[] }

export type MigrationRoleState = {
  rolname: string
  rolsuper: boolean
  rolbypassrls: boolean
}

export type MigrationRoleDecision = {
  action: 'proceed' | 'warn' | 'refuse'
  message: string
}

export function validateMigrationRole(state: MigrationRoleState): MigrationRoleDecision {
  if (!state.rolsuper && state.rolbypassrls) {
    return {
      action: 'refuse',
      message: `FATAL: non-superuser migration role ${state.rolname} has BYPASSRLS; this makes Story 24.1's RLS boundary inert. Use a role without BYPASSRLS.`,
    }
  }
  if (state.rolsuper) {
    return {
      action: 'warn',
      message:
        `WARN: migration role ${state.rolname} is SUPERUSER${state.rolbypassrls ? ' (also marked BYPASSRLS)' : ''} and bypasses RLS. ` +
        'Cross-organization migrations must use the documented joined-org mechanism; do not disable or bypass RLS in a migration.',
    }
  }
  return {
    action: 'proceed',
    message: `Migration role ${state.rolname} is non-superuser and non-BYPASSRLS; RLS remains active during migration execution.`,
  }
}

/** drizzle-kit's generated tag shape: a 4-digit index, `_`, then a lowercase snake_case name. */
const MIGRATION_TAG_PATTERN = /^\d{4}_[a-z0-9_]+$/

/** Defence in depth: a journal tag becomes part of a filesystem path, so a tampered or corrupted
 * journal entry (`../x`, `0001_ok/../../x`) must be rejected before it is ever joined into one. */
function assertValidMigrationTag(tag: unknown): void {
  if (typeof tag !== 'string' || !MIGRATION_TAG_PATTERN.test(tag)) {
    throw new Error(
      `Invalid migration tag ${JSON.stringify(tag)} in drizzle journal: expected ${String(MIGRATION_TAG_PATTERN)}`
    )
  }
}

/** Reads every migration file listed in `${migrationsDir}/meta/_journal.json`, in journal (idx)
 * order — the full local migration history, not filtered to pending ones. Every tag is validated
 * up front, before any migration file is read. */
export function readLocalMigrations(migrationsDir: string): LocalMigration[] {
  const journalPath = resolve(migrationsDir, 'meta', '_journal.json')
  if (!existsSync(journalPath)) {
    throw new Error(`Cannot find ${journalPath}`)
  }
  const journal = JSON.parse(readFileSync(journalPath, 'utf-8')) as Journal
  for (const entry of journal.entries) assertValidMigrationTag(entry.tag)
  return journal.entries
    .slice()
    .sort((a, b) => a.idx - b.idx)
    .map((entry) => ({
      tag: entry.tag,
      sql: readFileSync(resolve(migrationsDir, `${entry.tag}.sql`), 'utf-8'),
      folderMillis: entry.when,
    }))
}

/** Mirrors drizzle-kit's own pending-detection rule: every migration is pending when nothing has
 * been applied yet (`lastAppliedMillis === null`); otherwise only migrations newer than the last
 * applied one are pending. */
export function resolvePendingMigrations(
  all: LocalMigration[],
  lastAppliedMillis: number | null
): LocalMigration[] {
  if (lastAppliedMillis === null) return all
  return all.filter((migration) => migration.folderMillis > lastAppliedMillis)
}

/** Runs `findDestructiveStatements` against every pending migration and returns only the ones
 * with at least one finding (the "offending" subset), in pending order. */
export function scanPendingForDestructive(pending: LocalMigration[]): DestructiveScanResult[] {
  const results: DestructiveScanResult[] = []
  for (const migration of pending) {
    if (migration.tag in KNOWN_REVIEWED_DESTRUCTIVE_MIGRATIONS) continue
    const findings = findDestructiveStatements(migration.sql)
    if (findings.length > 0) results.push({ tag: migration.tag, findings })
  }
  return results
}

/** AC-3: refuse the entire pending batch (not just the offending file) whenever any pending
 * migration is destructive and `--allow-destructive` was not passed — never apply migrations 1-2
 * silently while blocking only migration 3. */
export function decideMigrationAction(
  offending: DestructiveScanResult[],
  allowDestructive: boolean
): MigrationAction {
  if (offending.length > 0 && !allowDestructive) return 'refuse'
  return 'proceed'
}

const RUNBOOK_CROSS_REFERENCE = 'docs/runbook.md § Upgrades'

/** AC-3/AC-20: the refusal message printed to stderr — names every offending file and finding,
 * and cross-references Story 9.5's (forward-referenced, may not exist yet) offline migration
 * procedure so the error message is actionable rather than a dead end. */
export function buildRefusalMessage(offending: DestructiveScanResult[]): string {
  const lines: string[] = []
  for (const { tag, findings } of offending) {
    lines.push(`FATAL: migration ${tag}.sql contains a destructive operation:`)
    for (const finding of findings) {
      lines.push(`  ${finding}`)
    }
  }
  lines.push(
    'In-place auto-migration refuses destructive schema changes (AC-E9b).',
    `Follow the documented offline migration procedure (see ${RUNBOOK_CROSS_REFERENCE}),`,
    'or re-run with --allow-destructive if you have already completed that procedure.'
  )
  return `${lines.join('\n')}\n`
}

type MigrationLogEvent =
  | { kind: 'refused'; offending: DestructiveScanResult[] }
  | { kind: 'allowed'; offending: DestructiveScanResult[] }
  | { kind: 'applied'; applied: string[] }

/** AC-17: structured pino-style operational log events for every migration-safety decision this
 * script makes — this runs pre-vault-unseal in a one-shot container with no org/audit context, so
 * these are operational logs, never `audit_log_entries` rows. */
export function buildMigrationLogEvent(input: MigrationLogEvent): Record<string, unknown> {
  if (input.kind === 'refused') {
    return {
      event: OperationalEvent.MIGRATION_DESTRUCTIVE_REFUSED,
      level: 'error',
      files: input.offending.map((o) => o.tag),
      findings: input.offending.flatMap((o) => o.findings),
    }
  }
  if (input.kind === 'allowed') {
    return {
      event: OperationalEvent.MIGRATION_DESTRUCTIVE_ALLOWED,
      level: 'warn',
      files: input.offending.map((o) => o.tag),
      findings: input.offending.flatMap((o) => o.findings),
      allowDestructive: true,
    }
  }
  return {
    event: OperationalEvent.MIGRATION_APPLIED,
    level: 'info',
    files: input.applied,
  }
}

function log(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

/** Applies every pending migration in `migrationsFolder` with drizzle-orm's own migrator — the
 * exact code path `drizzle-kit migrate` delegates to (same `drizzle.__drizzle_migrations`
 * bookkeeping and pending rule, the whole pending batch in one transaction). Calling it directly
 * rather than spawning drizzle-kit means the published `migrate` image can run compiled JS with
 * production dependencies only: no drizzle-kit, tsx or esbuild binaries, which the Story 64.3
 * release vulnerability gate flagged (Go stdlib CVEs in esbuild). Server NOTICEs (e.g. the
 * migrator's own `CREATE SCHEMA IF NOT EXISTS`) are dropped, matching drizzle-kit's output. */
export async function applyMigrations(
  databaseUrl: string,
  migrationsFolder: string
): Promise<void> {
  const sql = postgres(databaseUrl, { ...pgTlsOptions(), max: 1, onnotice: () => undefined })
  try {
    await migrate(drizzle(sql), { migrationsFolder })
  } finally {
    await sql.end()
  }
}

/** Queries `drizzle.__drizzle_migrations` for the most recently applied migration's `created_at`
 * — `null` when the table/schema doesn't exist yet (fresh database, nothing applied). Read-only:
 * never creates the table, since a refused destructive migration must leave the database
 * completely untouched (AC-3). */
export async function fetchLastAppliedMillis(databaseUrl: string): Promise<number | null> {
  const sql = postgres(databaseUrl, { ...pgTlsOptions(), max: 1 })
  try {
    const rows = await sql<{ created_at: string }[]>`
      select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1
    `
    const value = rows[0]?.created_at
    return value === undefined ? null : Number(value)
  } catch {
    // Schema/table not present yet — nothing has ever been applied.
    return null
  } finally {
    await sql.end()
  }
}

export async function fetchMigrationRoleState(databaseUrl: string): Promise<MigrationRoleState> {
  const sql = postgres(databaseUrl, { ...pgTlsOptions(), max: 1 })
  try {
    const rows = await sql<MigrationRoleState[]>`
      SELECT current_user AS rolname, rolsuper, rolbypassrls
        FROM pg_roles
       WHERE rolname = current_user
    `
    const state = rows[0]
    if (!state) throw new Error('Cannot determine migration connection role')
    return state
  } finally {
    await sql.end()
  }
}

export async function main(): Promise<void> {
  const allowDestructive = process.argv.includes('--allow-destructive')
  const databaseUrl = process.env['DATABASE_URL']
  if (!databaseUrl) {
    process.stderr.write('FATAL: DATABASE_URL is not set\n')
    process.exitCode = 1
    return
  }

  const migrationsDir = resolve(__dirname, '../migrations')
  const all = readLocalMigrations(migrationsDir)
  const lastAppliedMillis = await fetchLastAppliedMillis(databaseUrl)
  const pending = resolvePendingMigrations(all, lastAppliedMillis)
  const offending = scanPendingForDestructive(pending)
  const action = decideMigrationAction(offending, allowDestructive)

  if (action === 'refuse') {
    log(buildMigrationLogEvent({ kind: 'refused', offending }))
    process.stderr.write(buildRefusalMessage(offending))
    process.exitCode = 1
    return
  }

  if (offending.length > 0) {
    log(buildMigrationLogEvent({ kind: 'allowed', offending }))
  }

  let roleDecision: MigrationRoleDecision
  try {
    roleDecision = validateMigrationRole(await fetchMigrationRoleState(databaseUrl))
  } catch (error) {
    process.stderr.write(`FATAL: migration role preflight failed: ${(error as Error).message}\n`)
    process.exitCode = 1
    return
  }
  if (roleDecision.action === 'refuse') {
    process.stderr.write(`${roleDecision.message}\n`)
    process.exitCode = 1
    return
  }
  process.stderr.write(`${roleDecision.message}\n`)

  try {
    await applyMigrations(databaseUrl, migrationsDir)
  } catch (error) {
    // A non-zero exit is what satisfies AC-2 (migrate service exits non-zero, api never starts);
    // the whole pending batch ran in one transaction, so nothing was partially applied.
    process.stderr.write(
      `FATAL: migration failed: ${error instanceof Error ? error.message : String(error)}\n`
    )
    process.exitCode = 1
    return
  }

  log(buildMigrationLogEvent({ kind: 'applied', applied: pending.map((m) => m.tag) }))
}

// `e2e/global-setup.ts` invokes this file as `node tsx/cli.mjs guarded-migrate.ts`, so the
// migration path is not necessarily argv[1]. Check every CLI argument to keep both the package
// script (`tsx guarded-migrate.ts`) and the explicit Node/tsx invocation executable.
export function isInvokedScript(argumentsList: string[], filename: string): boolean {
  return argumentsList.some((argument) => resolve(argument) === filename)
}

export async function runIfInvokedScript(
  argumentsList: string[],
  filename: string,
  run: () => Promise<void>
): Promise<void> {
  if (!isInvokedScript(argumentsList, filename)) return
  try {
    await run()
  } catch (error: unknown) {
    process.stderr.write(`FATAL: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

await runIfInvokedScript(process.argv.slice(1), __filename, main)
