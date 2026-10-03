#!/usr/bin/env tsx
/**
 * Story 68.7 AC-10: every PV nav item has a stable, well-formed, unique id inside its surface, read
 * from apps/web's nav registry with the TypeScript parser (and the surface builders).
 *
 *   tsx scripts/check-nav-ids.ts [--web <dir>]
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkNavIdsGuard } from './lib/nav-guards.js'

export function run(args: readonly string[]): number {
  const index = args.indexOf('--web')
  const webRoot = resolve(index === -1 ? 'apps/web' : (args[index + 1] ?? 'apps/web'))
  const result = checkNavIdsGuard(webRoot)
  if (result.problems.length === 0) {
    process.stdout.write(`check-nav-ids: ${result.ids} ids in ${result.surfaces} surfaces — OK\n`)
    return 0
  }
  process.stderr.write('FATAL: nav ids:\n')
  for (const problem of result.problems) process.stderr.write(`  - ${problem}\n`)
  return 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = run(process.argv.slice(2))
}
