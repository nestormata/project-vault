#!/usr/bin/env tsx
/**
 * Story 68.10 AC-4: every `<!-- @region <name> -->` block in a PV-originated `.svelte` file is a
 * component or contains one (so it can be replaced individually through M4). The scanner ships with
 * web-host (apps/web/guards/monolithic-region.ts); this is the repository's thin CLI over it.
 *
 *   tsx scripts/check-monolithic-regions.ts [--web <dir>] [--lock <composition.lock.json>]
 *
 * With `--lock`, files the lock records as CM's (overrides, additions, materialized) are not
 * checked: provenance, never a path list. No other file is ever exempted.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { scanMonolithicRegionsTree } from '../apps/web/guards/monolithic-region.js'

interface LockProvenance {
  overrides?: { path: string }[]
  additions?: { path: string }[]
  materialized?: { path: string }[]
}

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

function cmFiles(lock: LockProvenance): string[] {
  return [lock.overrides, lock.additions, lock.materialized]
    .flatMap((list) => list ?? [])
    .map((entry) => entry.path)
}

export function run(args: readonly string[], io: Io = STD): number {
  const webRoot = resolve(option(args, '--web') ?? 'apps/web')
  const lockPath = option(args, '--lock')
  let exempt: string[] = []
  if (lockPath !== undefined) {
    if (!existsSync(resolve(lockPath))) {
      io.err(`FATAL: --lock ${lockPath} does not exist\n`)
      return 1
    }
    exempt = cmFiles(JSON.parse(readFileSync(resolve(lockPath), 'utf8')) as LockProvenance)
  }
  const result = scanMonolithicRegionsTree(webRoot, exempt)
  const problems = result.findings.map(
    (finding) => `${finding.file}:${finding.line}: ${finding.message}`
  )
  if (result.files + result.exempted === 0) {
    problems.push(
      'scanned 0 files: no .svelte files found (a guard that matches nothing is not a pass)'
    )
  }
  if (problems.length === 0) {
    io.out(
      `check-monolithic-regions: scanned ${result.files} files, ${result.regions} regions — OK\n`
    )
    return 0
  }
  io.err(`FATAL: monolithic regions (scanned ${result.files} files, ${result.regions} regions):\n`)
  for (const problem of problems) io.err(`  ${problem}\n`)
  return 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = run(process.argv.slice(2))
}
