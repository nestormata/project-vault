#!/usr/bin/env tsx
/**
 * Story 9.3 D3/AC-4/AC-18 — CI-only, full-history compatibility gate: scans *every* committed
 * migration file (not just pending ones — see `packages/db/src/scripts/guarded-migrate.ts` for
 * the runtime, pending-only guard) for destructive operations. Reuses D2's
 * `findDestructiveStatements` — never duplicates the pattern logic (this repo's `pnpm jscpd`
 * gate would flag a second copy).
 *
 * Pure, DB-free: this is a static file scan, so it runs identically with no Postgres reachable at
 * all, unlike `guarded-migrate.ts` which needs a live connection to determine pending state.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { findDestructiveStatements } from '../packages/db/src/lib/migration-safety.js'
import { toRepoPath, walkFiles } from './lib/scan-utils.js'

export type MigrationViolation = { file: string; findings: string[] }

export function scanMigrationCompatibility(rootDir = process.cwd()): MigrationViolation[] {
  const root = resolve(rootDir)
  const migrationsDir = resolve(root, 'packages/db/src/migrations')
  const violations: MigrationViolation[] = []

  for (const file of walkFiles(migrationsDir, (path) => path.endsWith('.sql'))) {
    const findings = findDestructiveStatements(readFileSync(file, 'utf-8'))
    if (findings.length > 0) {
      violations.push({ file: toRepoPath(root, file), findings })
    }
  }

  return violations.sort((a, b) => a.file.localeCompare(b.file))
}

function report(violations: MigrationViolation[]): void {
  if (violations.length === 0) {
    process.stdout.write(
      'migration-compatibility-check: no destructive statements in any committed migration — OK\n'
    )
    return
  }

  process.stderr.write(
    'FATAL: destructive migration statement(s) detected (AC-E9b) — additive-only migrations are required:\n'
  )
  for (const violation of violations) {
    process.stderr.write(`  - ${violation.file}\n`)
    for (const finding of violation.findings) {
      process.stderr.write(`      ${finding}\n`)
    }
  }
  process.stderr.write(
    '\nIf this is an intentional, reviewed destructive change, follow the documented offline\n' +
      'migration procedure (see docs/runbook.md § Upgrades) rather than merging it as a normal\n' +
      'in-place migration.\n'
  )
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  report(scanMigrationCompatibility())
}
