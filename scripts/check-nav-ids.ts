#!/usr/bin/env tsx
/**
 * Story 68.7 AC-10: every PV nav item has a stable, well-formed, unique id inside its surface, read
 * from apps/web's nav registry with the TypeScript parser (and the surface builders).
 *
 *   tsx scripts/check-nav-ids.ts [--web <dir>]
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkNavIdsGuard, reportGuard } from './lib/nav-guards.js'

export function run(args: readonly string[]): number {
  const index = args.indexOf('--web')
  const webRoot = resolve(index === -1 ? 'apps/web' : (args[index + 1] ?? 'apps/web'))
  const result = checkNavIdsGuard(webRoot)
  const ok = `check-nav-ids: ${result.ids} ids in ${result.surfaces} surfaces — OK`
  return reportGuard(result.problems, ok, 'nav ids')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = run(process.argv.slice(2))
}
