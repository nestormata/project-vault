#!/usr/bin/env tsx
/**
 * Story 43.6 (AC-5 step 5) — stamps the release version and short commit into BOTH
 * `packages/agent/src/build-info.ts` and `packages/cli/src/build-info.ts` in one step, from the
 * same arguments, so a released `pvault` bundle can never report a skewed agent. Run only by the
 * release workflow on a throwaway checkout; never touches any `package.json` (their versions stay
 * `0.0.1` on purpose — docs/releasing.md).
 *
 * Usage: tsx scripts/stamp-build-info.ts --version X.Y.Z --commit abcdef0
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  BUILD_INFO_FILES,
  RELEASE_VERSION_PATTERN,
  SHORT_COMMIT_PATTERN,
  stampBuildInfoSource,
  type BuildInfoValue,
} from './lib/build-info-template.js'

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  return index === -1 ? undefined : argv[index + 1]
}

export function parseStampArgs(argv: string[]): { version: string; commit: string } {
  const version = flagValue(argv, '--version')
  const commit = flagValue(argv, '--commit')
  if (!version || !RELEASE_VERSION_PATTERN.test(version)) {
    throw new Error(
      `--version must match ${RELEASE_VERSION_PATTERN} (got ${JSON.stringify(version)})`
    )
  }
  if (!commit || !SHORT_COMMIT_PATTERN.test(commit)) {
    throw new Error(`--commit must match ${SHORT_COMMIT_PATTERN} (got ${JSON.stringify(commit)})`)
  }
  return { version, commit }
}

export function stampBuildInfo(repoRoot: string, info: BuildInfoValue): void {
  // Read and render every file first so a failure never leaves one stamped and the other not.
  const rendered = BUILD_INFO_FILES.map((file) => {
    const fullPath = join(repoRoot, file.path)
    return {
      fullPath,
      content: stampBuildInfoSource(readFileSync(fullPath, 'utf8'), file.constName, info),
    }
  })
  for (const { fullPath, content } of rendered) writeFileSync(fullPath, content)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const info = parseStampArgs(process.argv.slice(2))
    stampBuildInfo(process.cwd(), info)
    process.stdout.write(`stamp-build-info: stamped ${info.version} (commit ${info.commit})\n`)
  } catch (error) {
    process.stderr.write(`FATAL: stamp-build-info: ${(error as Error).message}\n`)
    process.exitCode = 1
  }
}
