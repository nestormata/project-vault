#!/usr/bin/env tsx
/**
 * Story 68.7 AC-10: in PV-originated `.svelte` files, every `<nav>` element and every
 * `aria-current` attribute lives in a registered nav surface renderer (apps/web's nav registry).
 * A new nav surface is registered and rendered from data, never exempted.
 *
 *   tsx scripts/check-nav-surfaces.ts [--web <dir>] [--lock <composition.lock.json>]
 *
 * With `--lock`, files the lock records as CM's are not checked (provenance, never a path list).
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkNavSurfacesGuard, reportGuard, type LockProvenance } from './lib/nav-guards.js'

function option(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

export function run(args: readonly string[]): number {
  const webRoot = resolve(option(args, '--web') ?? 'apps/web')
  const lockPath = option(args, '--lock')
  if (lockPath !== undefined && !existsSync(resolve(lockPath))) {
    process.stderr.write(`FATAL: --lock ${lockPath} does not exist\n`)
    return 1
  }
  const lock =
    lockPath === undefined
      ? undefined
      : (JSON.parse(readFileSync(resolve(lockPath), 'utf8')) as LockProvenance)
  const result = checkNavSurfacesGuard(webRoot, lock)
  const scanned = `scanned ${result.scannedFiles} .svelte files`
  return reportGuard(
    result.problems,
    `check-nav-surfaces: ${scanned} — OK`,
    `nav surfaces (${scanned})`
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = run(process.argv.slice(2))
}
