#!/usr/bin/env tsx
/**
 * Story 68.4 AC-10: every PV route file exposes the three standard injection points, every
 * `@region` block holds a point, every point name is registered, and every page/layout server file
 * calls `injectLoad`/`injectActions` with its own route id and scope. Checks PV-originated files only.
 *
 *   tsx scripts/check-injection-point-coverage.ts [--web <dir>] [--lock <composition.lock.json>]
 *
 * With `--lock`, files the lock records as CM's (overrides, additions, materialized) are not checked:
 * provenance, never a path list. No other file is ever exempted.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { STD_IO, type Io } from './lib/cli-io.js'
import {
  checkInjectionPointCoverage,
  coverageFigure,
  type CoverageOptions,
  formatFigure,
  type LockProvenance,
} from './lib/injection-point-coverage.js'
import { censusProblem } from './lib/route-files.js'

function option(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

function readLock(path: string): LockProvenance | undefined {
  if (!existsSync(path)) {
    process.stderr.write(`FATAL: --lock ${path} does not exist\n`)
    process.exitCode = 1
    return undefined
  }
  return JSON.parse(readFileSync(path, 'utf8')) as LockProvenance
}

function collectProblems(options: CoverageOptions, locked: boolean): string[] {
  const result = checkInjectionPointCoverage(options)
  const problems = [...result.problems]
  // A composed tree does not carry PV's route-render oracle; only PV's own tree has a census.
  const census = locked ? null : censusProblem(options.webRoot, result.scannedRouteFiles)
  if (census !== null) problems.push(census)
  return problems
}

export function run(args: readonly string[], io: Io = STD_IO): number {
  const webRoot = resolve(option(args, '--web') ?? 'apps/web')
  const lockPath = option(args, '--lock')
  const lock = lockPath === undefined ? undefined : readLock(resolve(lockPath))
  if (lockPath !== undefined && lock === undefined) return 1
  const options: CoverageOptions = { webRoot, ...(lock === undefined ? {} : { lock }) }
  const figure = coverageFigure(options)
  const problems = collectProblems(options, lock !== undefined)
  if (figure.percent < 100) problems.push(`coverage is ${figure.percent}%, not 100%`)
  const heading = `scanned ${figure.routeFiles} route files`
  if (problems.length === 0) {
    io.out(`check-injection-point-coverage: ${heading} — OK\n${formatFigure(figure)}\n`)
    return 0
  }
  io.err(`FATAL: injection point coverage (${heading}):\n`)
  for (const problem of problems) io.err(`  - ${problem}\n`)
  io.err(`${formatFigure(figure)}\n`)
  return 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = run(process.argv.slice(2))
}
