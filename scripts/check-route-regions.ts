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
import { STD_IO, failWith, option, runAsMain, type Io } from './lib/cli-io.js'
import {
  auditRouteRegions,
  formatTable,
  formatUsesTable,
  OVERSIZE_ENFORCEMENT,
  OVERSIZE_FOLLOW_UP_STORIES,
} from './lib/route-regions.js'

export function run(args: readonly string[], io: Io = STD_IO): number {
  const webRoot = resolve(option(args, '--web') ?? 'apps/web')
  const result = auditRouteRegions(webRoot)
  const problems = [...result.problems]
  if (result.routeFiles === 0) {
    problems.push('no route files found (a guard that matches nothing is not a pass)')
  }
  if (args.includes('--print')) {
    io.out(`${formatTable(result.rows)}\n\n${formatUsesTable(result.uses)}\n`)
  }
  if (result.oversize.length > 0 && !OVERSIZE_ENFORCEMENT) {
    io.out(
      `check-route-regions: ${result.oversize.length} OVERSIZE region components (report-only until stories ${OVERSIZE_FOLLOW_UP_STORIES.join(', ')} split them):\n${result.oversize.map((line) => `  ${line}`).join('\n')}\n`
    )
  }
  if (problems.length === 0) {
    io.out(
      `check-route-regions: ${result.routeFiles} route files, ${result.rows.length} regions — OK\n`
    )
    return 0
  }
  return failWith(
    io,
    `route regions (${result.routeFiles} route files, ${result.rows.length} regions)`,
    problems
  )
}

runAsMain(import.meta.url, run)
