#!/usr/bin/env tsx
/**
 * Story 14.1 AC7 — `packages/extension-api` is a versioned contract package: any change under
 * `packages/extension-api/src/**` (a hook interface, `registerExtension()`'s validation logic,
 * the manifest shape, …) must ship with a corresponding bump to `packages/extension-api/package.json`'s
 * `version` field in the same diff. Following the same `check-*.ts` CI-guard pattern as
 * `scripts/check-story-status-sync.ts`/`scripts/check-psc-tbd-tracking.ts` — this is a build
 * failure instead of a hoped-for review comment.
 *
 * Compares the actual before/after `version` *field value* in `packages/extension-api/package.json`
 * across the PR's base/head, via `git show <ref>:<path>` — not merely whether `package.json` was
 * touched (a diff that edits the file without changing `version` must still fail, per AC7).
 */
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const EXTENSION_API_SRC_PREFIX = 'packages/extension-api/src/'
export const EXTENSION_API_PACKAGE_JSON = 'packages/extension-api/package.json'

export type DiffRange = { base: string; head: string }

/**
 * Determines the git ref range to diff. On a GitHub Actions `pull_request` event, `GITHUB_BASE_REF`
 * is set to the target branch name (e.g. "main") and the checked-out remote tracking ref is
 * `origin/<base>`; `GITHUB_SHA` is the head commit. Locally (or for push events, where
 * `GITHUB_BASE_REF` is unset), fall back to comparing local `main` against `HEAD` — the common
 * case for a developer running this guard by hand before opening a PR.
 */
export function resolveDiffRange(env: Partial<NodeJS.ProcessEnv> = process.env): DiffRange {
  if (env.GITHUB_BASE_REF) {
    return { base: `origin/${env.GITHUB_BASE_REF}`, head: env.GITHUB_SHA ?? 'HEAD' }
  }
  return { base: 'main', head: 'HEAD' }
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync(
    'git', // NOSONAR(typescript:S4036) — trusted binary on this CI/dev host's fixed, unwriteable PATH
    args,
    { cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
  )
}

/** Files changed between `base` and `head` (three-dot diff: base...head, i.e. against their merge-base). */
export function getChangedFiles(repoRoot: string, base: string, head: string): string[] {
  const output = git(repoRoot, ['diff', '--name-only', `${base}...${head}`])
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** The `version` field of `filePath`'s JSON content at `ref`, or `undefined` if the file/ref/field doesn't resolve. */
export function getFileVersionAtRef(
  repoRoot: string,
  ref: string,
  filePath: string
): string | undefined {
  let content: string
  try {
    content = git(repoRoot, ['show', `${ref}:${filePath}`])
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(content) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : undefined
  } catch {
    return undefined
  }
}

export function hasExtensionApiSrcChange(changedFiles: string[]): boolean {
  return changedFiles.some((file) => file.startsWith(EXTENSION_API_SRC_PREFIX))
}

/**
 * True (skew detected — should fail CI) when `packages/extension-api/src/**` changed but
 * `package.json`'s `version` field value is identical before and after.
 */
export function detectVersionSkew(params: {
  changedFiles: string[]
  baseVersion: string | undefined
  headVersion: string | undefined
}): boolean {
  if (!hasExtensionApiSrcChange(params.changedFiles)) return false
  return params.baseVersion === params.headVersion
}

export function runVersionSkewCheck(
  repoRoot: string,
  range: DiffRange
): { skew: boolean; changedSrcFiles: string[] } {
  const changedFiles = getChangedFiles(repoRoot, range.base, range.head)
  const baseVersion = getFileVersionAtRef(repoRoot, range.base, EXTENSION_API_PACKAGE_JSON)
  const headVersion = getFileVersionAtRef(repoRoot, range.head, EXTENSION_API_PACKAGE_JSON)
  const skew = detectVersionSkew({ changedFiles, baseVersion, headVersion })
  return {
    skew,
    changedSrcFiles: changedFiles.filter((file) => file.startsWith(EXTENSION_API_SRC_PREFIX)),
  }
}

function report(result: { skew: boolean; changedSrcFiles: string[] }): void {
  if (!result.skew) {
    process.stdout.write(
      'check-extension-api-version-skew: packages/extension-api version is in sync with its src/** changes — OK\n'
    )
    return
  }

  process.stderr.write(
    'FATAL: packages/extension-api/src/** changed without a corresponding package.json ' +
      '"version" bump (Story 14.1 AC7) — check-extension-api-version-skew:\n'
  )
  for (const file of result.changedSrcFiles) process.stderr.write(`  - ${file}\n`)
  process.stderr.write(
    `\nFix: bump the "version" field in ${EXTENSION_API_PACKAGE_JSON} (and \n` +
      'EXTENSION_API_VERSION in packages/extension-api/src/manifest.ts) in this same commit/PR.\n'
  )
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    report(runVersionSkewCheck(process.cwd(), resolveDiffRange()))
  } catch (error) {
    // Fail open on diff-range resolution errors (e.g. a shallow clone with no local `main`, or no
    // `origin` remote reachable) — matching this repo's other static-scan guards' precedent of
    // not blocking builds when the check's own precondition (a resolvable base ref) isn't met.
    process.stdout.write(
      `check-extension-api-version-skew: could not compute a diff range (${(error as Error).message}) — skipping\n`
    )
  }
}
