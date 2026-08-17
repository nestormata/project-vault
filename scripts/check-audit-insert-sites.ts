#!/usr/bin/env tsx
/**
 * Story 22.1 AC-13 — makes the "single chokepoint" claim enforceable rather than merely
 * asserted in prose (review finding C1: the original story's four-site enumeration was wrong by
 * half; a chokepoint that is only asserted regresses on the next PR). Scans production source
 * under `apps/**` and `packages/**` (excluding `*.test.ts`) for every `audit_log_entries` INSERT,
 * in both idioms this codebase actually uses:
 *   1. the Drizzle idiom  — `insert(` ... `auditLogEntries`
 *   2. raw SQL            — a string/tagged-template containing `INSERT INTO audit_log_entries`
 * and fails the build if a match's file:approximate-line is not in the allowlist below.
 *
 * Known limit, stated rather than papered over (cold-verification finding NF-22): a
 * dynamically-selected table reference (`const t = cond ? a : b; tx.insert(t)`) defeats this
 * grep-based guard. It is a regression tripwire for the nine idioms that exist today, not a
 * proof — the compensating control is that assertOrgMayWriteAudit() lives beside every writer and
 * each site has its own behavioural test (AC-30 #7).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname, join, relative } from 'node:path'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')

const SCAN_ROOTS = ['apps', 'packages']
const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', '.turbo', 'coverage', 'migrations'])

/**
 * Every currently-known `audit_log_entries` INSERT site, one comment each — this list IS the
 * chokepoint's audit trail. A ninth (or later, tenth) site discovered by re-verifying this story's
 * citations (Task 1) belongs here with the same discipline: file path relative to repo root.
 */
const ALLOWLIST = new Set<string>([
  // Site 1 — writeHumanAuditEntry
  'apps/api/src/modules/audit/human-entry.ts',
  // Sites 2/3 — writeMachineAuditEntry / writeSystemAuditEntry
  'apps/api/src/modules/audit/machine-entry.ts',
  // Site 4 — secure-route.ts's inline defaultAuditWriter
  'apps/api/src/lib/secure-route.ts',
  // Site 5 — the shared system-audit-row.ts helper (background-worker audit family fan-out +
  // extensions/loader.ts's injected per-org writer for loaded module packs)
  'apps/api/src/lib/system-audit-row.ts',
  // Site 6 — auth/service.ts's insertAuditEntry
  'apps/api/src/modules/auth/service.ts',
  // Site 7 — session-revoke.ts
  'apps/api/src/modules/auth/session-revoke.ts',
  // Site 8 — prune-credential-versions.ts's inline worker insert
  'apps/api/src/workers/prune-credential-versions.ts',
  // Site 9 — capability-gate-audit.ts (Story 23.3, landed after this story was drafted; found by
  // re-verifying the insert-site count at implementation time, per Task 1)
  'apps/api/src/lib/capability-gate-audit.ts',
])

const DRIZZLE_IDIOM = /\.insert\s*\(\s*[\s\S]{0,80}?auditLogEntries/g
const RAW_SQL_IDIOM = /insert\s+into\s+audit_log_entries/gi

function isTestFile(path: string): boolean {
  return path.endsWith('.test.ts') || path.endsWith('.test.tsx')
}

function* walk(dir: string): Generator<string> {
  let entries: ReturnType<typeof readdirSync>
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walk(full)
    } else if (entry.isFile() && (full.endsWith('.ts') || full.endsWith('.tsx'))) {
      yield full
    }
  }
}

export function findUnallowlistedInsertSites(repoRoot: string): string[] {
  const offenders: string[] = []
  for (const scanRoot of SCAN_ROOTS) {
    const rootDir = join(repoRoot, scanRoot)
    try {
      statSync(rootDir)
    } catch {
      continue
    }
    for (const filePath of walk(rootDir)) {
      const relPath = relative(repoRoot, filePath).replaceAll('\\', '/')
      if (isTestFile(relPath)) continue
      const source = readFileSync(filePath, 'utf-8')
      const matchesDrizzle = DRIZZLE_IDIOM.test(source)
      DRIZZLE_IDIOM.lastIndex = 0
      const matchesRaw = RAW_SQL_IDIOM.test(source)
      RAW_SQL_IDIOM.lastIndex = 0
      if ((matchesDrizzle || matchesRaw) && !ALLOWLIST.has(relPath)) {
        offenders.push(relPath)
      }
    }
  }
  return offenders
}

function main(): void {
  const offenders = findUnallowlistedInsertSites(REPO_ROOT)
  if (offenders.length === 0) {
    process.stdout.write(
      `check-audit-insert-sites: ${ALLOWLIST.size} allowlisted audit_log_entries insert sites, no un-allowlisted sites found — OK\n`
    )
    return
  }
  process.stderr.write(
    `FATAL: audit_log_entries INSERT found outside the Story 22.1 AC-13 allowlist in ${offenders.length} file(s):\n`
  )
  for (const offender of offenders) {
    process.stderr.write(
      `  - ${offender} — must call assertOrgMayWriteAudit() before its insert and be added to scripts/check-audit-insert-sites.ts's ALLOWLIST with a one-line comment\n`
    )
  }
  process.exitCode = 1
}

main()
