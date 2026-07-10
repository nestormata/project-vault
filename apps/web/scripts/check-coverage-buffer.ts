#!/usr/bin/env tsx
// Story 10.3 (AC-B2a, AC-D1): a package-local, tested one-shot verifier that enforces the 85%
// complete-source branch completion target from fresh `coverage/coverage-final.json` output,
// using integer arithmetic only. It intentionally never touches Vitest's `thresholds`, which
// remain the shared, unchanged 80% CI gate defined in `packages/tsconfig/vitest.base.ts`.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export type CoverageFinal = Record<string, { b?: Record<string, number[]> }>

export type BranchTotals = { covered: number; total: number }

export type VerifyResult = {
  ok: boolean
  message: string
  totals?: BranchTotals
}

/** Coverage older than this is considered stale: rerun coverage before trusting the verdict. */
export const STALE_AFTER_MS = 10 * 60 * 1000

const REQUIRED_PERCENT = 85

/** Sums covered/total branch paths across every file in a parsed `coverage-final.json`. */
export function computeBranchTotals(coverage: CoverageFinal): BranchTotals {
  let covered = 0
  let total = 0
  for (const file of Object.values(coverage)) {
    const branches = file.b ?? {}
    for (const hitCounts of Object.values(branches)) {
      total += hitCounts.length
      covered += hitCounts.filter((hits) => hits > 0).length
    }
  }
  return { covered, total }
}

/**
 * Integer-only 85% gate: `covered * 100 >= total * 85`. Rounded percentages are never compared.
 * A denominator of zero trivially passes (nothing eligible to fail).
 */
export function meetsBranchBuffer(totals: BranchTotals): boolean {
  if (totals.total === 0) return true
  return totals.covered * 100 >= totals.total * REQUIRED_PERCENT
}

function isFresh(mtimeMs: number, now: number): boolean {
  return now - mtimeMs <= STALE_AFTER_MS
}

export function verifyCoverageBuffer(
  coverageFinalPath: string,
  options: { now?: number } = {}
): VerifyResult {
  const now = options.now ?? Date.now()

  if (!existsSync(coverageFinalPath)) {
    return {
      ok: false,
      message: `coverage-final.json not found at ${coverageFinalPath}. Run coverage before verifying.`,
    }
  }

  const stats = statSync(coverageFinalPath)
  if (!isFresh(stats.mtimeMs, now)) {
    return {
      ok: false,
      message: `coverage-final.json at ${coverageFinalPath} is stale (older than ${STALE_AFTER_MS}ms). Rerun coverage before verifying.`,
    }
  }

  let coverage: CoverageFinal
  try {
    coverage = JSON.parse(readFileSync(coverageFinalPath, 'utf8')) as CoverageFinal
  } catch {
    return {
      ok: false,
      message: `coverage-final.json at ${coverageFinalPath} is malformed JSON and could not be parsed.`,
    }
  }

  const totals = computeBranchTotals(coverage)
  if (!meetsBranchBuffer(totals)) {
    return {
      ok: false,
      message: `Branch coverage ${totals.covered}/${totals.total} does not meet the ${REQUIRED_PERCENT}% completion target (integer check: covered*100 >= total*85).`,
      totals,
    }
  }

  return {
    ok: true,
    message: `Branch coverage ${totals.covered}/${totals.total} meets the ${REQUIRED_PERCENT}% completion target.`,
    totals,
  }
}

function report(result: VerifyResult): void {
  if (result.ok) {
    process.stdout.write(`check-coverage-buffer: ${result.message}\n`)
    return
  }
  process.stderr.write(`FATAL: check-coverage-buffer: ${result.message}\n`)
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const coveragePath = resolve(process.cwd(), 'coverage/coverage-final.json')
  report(verifyCoverageBuffer(coveragePath))
}
