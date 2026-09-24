#!/usr/bin/env tsx
/**
 * Story 43.6 (AC-5) — the committed `build-info.ts` files of `packages/agent` and `packages/cli`
 * must hold the unstamped `'dev'`/`null` defaults. A locally stamped copy that got committed would
 * make every checkout build claim to be a release it is not.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  BUILD_INFO_FILES,
  DEV_BUILD_INFO,
  findBuildInfoLine,
  renderBuildInfoLine,
} from './lib/build-info-template.js'

export function findStampedBuildInfo(repoRoot: string): string[] {
  const problems: string[] = []
  for (const file of BUILD_INFO_FILES) {
    const fullPath = join(repoRoot, file.path)
    if (!existsSync(fullPath)) {
      problems.push(`${file.path}: missing`)
      continue
    }
    const expected = renderBuildInfoLine(file.constName, DEV_BUILD_INFO)
    const actual = findBuildInfoLine(readFileSync(fullPath, 'utf8'), file.constName)
    if (actual !== expected) {
      problems.push(`${file.path}: expected "${expected}", found ${JSON.stringify(actual)}`)
    }
  }
  return problems
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const problems = findStampedBuildInfo(process.cwd())
  if (problems.length === 0) {
    process.stdout.write('check-build-info-unstamped: committed build-info is unstamped — OK\n')
  } else {
    process.stderr.write('FATAL: committed build-info must stay unstamped (dev/null):\n')
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`)
    process.exitCode = 1
  }
}
