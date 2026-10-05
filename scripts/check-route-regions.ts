#!/usr/bin/env tsx
/**
 * Story 69.5 AC-1 / AC-9: the route-region audit. Every PV route file (page, layout, error page) is
 * made of replaceable regions: `<!-- @region <name> -->` blocks, in the file or in the `$lib`
 * components it imports, each holding a registered injection point and a component under
 * `src/lib/components/`. Repository tooling (not shipped with web-host).
 *
 *   tsx scripts/check-route-regions.ts [--web <dir>] [--print]
 *
 * `--print` writes the region table (markdown) and still fails on any problem, so the printed table
 * is never a green light on its own. The table is regenerated from the tree, never committed.
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { auditRouteRegions, formatTable } from './lib/route-regions.js'

export interface Io {
  out: (text: string) => void
  err: (text: string) => void
}

const STD: Io = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
}

function option(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

export function run(args: readonly string[], io: Io = STD): number {
  const webRoot = resolve(option(args, '--web') ?? 'apps/web')
  const result = auditRouteRegions(webRoot)
  const problems = [...result.problems]
  if (result.routeFiles === 0) {
    problems.push('no route files found (a guard that matches nothing is not a pass)')
  }
  if (args.includes('--print')) io.out(`${formatTable(result.rows)}\n`)
  if (problems.length === 0) {
    io.out(
      `check-route-regions: ${result.routeFiles} route files, ${result.rows.length} regions — OK\n`
    )
    return 0
  }
  io.err(
    `FATAL: route regions (${result.routeFiles} route files, ${result.rows.length} regions):\n`
  )
  for (const problem of problems) io.err(`  ${problem}\n`)
  return 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = run(process.argv.slice(2))
}
