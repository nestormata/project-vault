#!/usr/bin/env tsx
/**
 * Story 14.1 AC7 / Story 24.4 — enforce forward-only versioning for the extension API contract.
 *
 * The guard compares canonical semver values and requires the head to be strictly greater than
 * the selected base. It tracks the contract paths below plus the loader's exact path; test files
 * are excluded by basename so test-only edits do not manufacture version churn. The runtime gate
 * remains Story 24.3's responsibility: these checks are independent, so passing CI does not imply
 * that a loading extension is compatible, and a compatible extension does not imply a passing CI
 * check.
 *
 * CI checks out the checks job with fetch-depth: 0 (ci.yml:47), which makes failing closed safe for
 * the authoritative path. Local runs intentionally compare against a merge-base and therefore
 * accept the residual where two branches allocate the same number before either is merged; the
 * pull-request merge ref compares against the target branch tip and rejects that collision.
 * EXTENSION_API_SKEW_ALLOW_BROKEN_BASE=1 is a reviewed escape hatch for a malformed base package;
 * it warns on stderr and never bypasses head-side validation. Branch protection must still require
 * up-to-date and non-skipped checks (DW-118), because a script cannot re-run a stale GitHub check.
 */
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import semver from 'semver'

export const EXTENSION_API_SRC_PREFIX = 'packages/extension-api/src/'
export const EXTENSION_API_PACKAGE_JSON = 'packages/extension-api/package.json'

// A version promises observable contract behaviour, including loader wiring and error mapping.
export const CONTRACT_PATHS = [
  EXTENSION_API_SRC_PREFIX, // Extension API types, manifest, and registration contract.
] as const
export const CONTRACT_FILES = [
  'apps/api/src/extensions/loader.ts', // Loader hook wiring and load_failed behaviour are observable to extensions.
] as const
export const EXCLUDED_PATTERNS = [
  /\.test\.ts$/, // Tests are not part of the shipped contract and must not force version churn.
] as const

const HEAD_REF = 'HEAD' as const
const MAIN_REF = 'main' as const
const BASE_TIP_COMPARISON = 'base-tip' as const
const MERGE_BASE_COMPARISON = 'merge-base' as const
const HEAD_SIDE = 'head' as const
const MISSING_VERSION = 'missing-version' as const
const INVALID_SEMVER = 'invalid-semver' as const
const UNRESOLVABLE_RANGE = 'unresolvable-range' as const
const NOT_GREATER_THAN_MERGE_BASE = 'not-greater-than-merge-base' as const

export type DiffRange = {
  base: string
  head: string
  comparison: typeof BASE_TIP_COMPARISON | typeof MERGE_BASE_COMPARISON
}

export type SkewVerdict =
  | { ok: true; reason: 'no-contract-change' }
  | { ok: true; reason: 'valid-increase'; from: string; to: string }
  | { ok: true; reason: 'new-package'; to: string }
  | { ok: false; code: 'no-bump'; base: string; head: string }
  | { ok: false; code: typeof NOT_GREATER_THAN_MERGE_BASE; base: string; head: string }
  | {
      ok: false
      code: typeof INVALID_SEMVER
      which: typeof MERGE_BASE_COMPARISON | typeof HEAD_SIDE
      value: string | undefined
    }
  | {
      ok: false
      code: typeof MISSING_VERSION
      which: typeof MERGE_BASE_COMPARISON | typeof HEAD_SIDE
    }
  | { ok: false; code: typeof UNRESOLVABLE_RANGE; detail: string }

export type VersionSkewCheckResult = {
  verdict: SkewVerdict
  changedContractFiles: string[]
  baseRef: string
  headRef: string
  baseSha?: string
  headSha?: string
  baseVersion?: string
  headVersion?: string
  baseWarning?: string
}

type DetectParams = {
  changedFiles: string[]
  baseVersion: string | undefined
  headVersion: string | undefined
  rangeError?: string
  baseMissing?: boolean
  allowBrokenBase?: boolean
}

function git(repoRoot: string, args: string[]): string {
  try {
    return execFileSync(
      'git', // NOSONAR(typescript:S4036) — trusted binary on this CI/dev host's fixed, unwriteable PATH
      args,
      { cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : ''
    const message = stderr.trim() || (error instanceof Error ? error.message : String(error))
    throw new Error(message)
  }
}

/** Determines the authoritative comparison. Pushes use the first parent; local runs use a fork point. */
export function resolveDiffRange(env: Partial<NodeJS.ProcessEnv> = process.env): DiffRange {
  if (env.GITHUB_EVENT_NAME === 'push') {
    return {
      base: `${HEAD_REF}^1`,
      head: env.GITHUB_SHA ?? HEAD_REF,
      comparison: BASE_TIP_COMPARISON,
    }
  }
  if (env.GITHUB_BASE_REF) {
    return {
      base: `origin/${env.GITHUB_BASE_REF}`,
      head: env.GITHUB_SHA ?? HEAD_REF,
      comparison: BASE_TIP_COMPARISON,
    }
  }
  return { base: MAIN_REF, head: HEAD_REF, comparison: MERGE_BASE_COMPARISON }
}

/** Files changed between two commits (three-dot diff, relative to their merge-base). */
export function getChangedFiles(repoRoot: string, base: string, head: string): string[] {
  const output = git(repoRoot, ['diff', '--name-only', `${base}...${head}`])
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** Resolves a merge-base, or undefined when the refs are unrelated/unavailable. */
export function getMergeBase(repoRoot: string, base: string, head: string): string | undefined {
  try {
    return git(repoRoot, ['merge-base', base, head]).trim()
  } catch {
    return undefined
  }
}

/** Returns the version field, preserving the old helper's undefined-on-read-failure contract. */
export function getFileVersionAtRef(
  repoRoot: string,
  ref: string,
  filePath: string
): string | undefined {
  try {
    const content = git(repoRoot, ['show', `${ref}:${filePath}`])
    const parsed = JSON.parse(content) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : undefined
  } catch {
    return undefined
  }
}

function isExcluded(file: string): boolean {
  const basename = file.split('/').pop() ?? file
  return EXCLUDED_PATTERNS.some((pattern) => pattern.test(basename))
}

function isContractFile(file: string): boolean {
  return (
    !isExcluded(file) &&
    (CONTRACT_PATHS.some((prefix) => file.startsWith(prefix)) ||
      CONTRACT_FILES.includes(file as never))
  )
}

/** True when at least one non-test contract path/file changed. The exclusion filters files, never the check. */
export function hasExtensionApiSrcChange(changedFiles: string[]): boolean {
  return changedFiles.some(isContractFile)
}

function isCanonicalSemver(value: string): boolean {
  return semver.valid(value, false) === value
}

function validateVersionInputs(params: DetectParams): SkewVerdict | undefined {
  if (params.headVersion === undefined)
    return { ok: false, code: MISSING_VERSION, which: HEAD_SIDE }
  if (params.baseVersion === undefined) {
    if (!params.baseMissing && !params.allowBrokenBase) {
      return { ok: false, code: MISSING_VERSION, which: MERGE_BASE_COMPARISON }
    }
    if (!isCanonicalSemver(params.headVersion)) {
      return { ok: false, code: INVALID_SEMVER, which: HEAD_SIDE, value: params.headVersion }
    }
    return { ok: true, reason: 'new-package', to: params.headVersion }
  }
  if (!isCanonicalSemver(params.headVersion)) {
    return { ok: false, code: INVALID_SEMVER, which: HEAD_SIDE, value: params.headVersion }
  }
  if (!isCanonicalSemver(params.baseVersion)) {
    if (params.allowBrokenBase) return { ok: true, reason: 'new-package', to: params.headVersion }
    return {
      ok: false,
      code: INVALID_SEMVER,
      which: MERGE_BASE_COMPARISON,
      value: params.baseVersion,
    }
  }
  return undefined
}

/**
 * Produces one structured verdict. The order is intentional: range, head existence, base
 * existence, head validity, base validity, equality, then ordering.
 */
export function detectVersionSkew(params: DetectParams): SkewVerdict {
  if (!hasExtensionApiSrcChange(params.changedFiles))
    return { ok: true, reason: 'no-contract-change' }
  if (params.rangeError) return { ok: false, code: UNRESOLVABLE_RANGE, detail: params.rangeError }
  const inputVerdict = validateVersionInputs(params)
  if (inputVerdict) return inputVerdict
  if (params.baseVersion === undefined || params.headVersion === undefined) {
    throw new Error('version validation returned no verdict for an absent version')
  }
  if (params.baseVersion === params.headVersion) {
    return { ok: false, code: 'no-bump', base: params.baseVersion, head: params.headVersion }
  }
  if (!semver.gt(params.headVersion, params.baseVersion)) {
    return {
      ok: false,
      code: NOT_GREATER_THAN_MERGE_BASE,
      base: params.baseVersion,
      head: params.headVersion,
    }
  }
  return { ok: true, reason: 'valid-increase', from: params.baseVersion, to: params.headVersion }
}

type PackageState = { exists: boolean; version: string | undefined }

function packageStateAtRef(repoRoot: string, ref: string): PackageState {
  // Verify the ref separately so an unavailable ref is not misreported as a new package.
  git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`])
  try {
    git(repoRoot, ['cat-file', '-e', `${ref}:${EXTENSION_API_PACKAGE_JSON}`])
  } catch {
    return { exists: false, version: undefined }
  }
  try {
    const parsed = JSON.parse(git(repoRoot, ['show', `${ref}:${EXTENSION_API_PACKAGE_JSON}`])) as {
      version?: unknown
    }
    return {
      exists: true,
      version: typeof parsed.version === 'string' ? parsed.version : undefined,
    }
  } catch {
    return { exists: true, version: undefined }
  }
}

function resolveComparisonBase(repoRoot: string, range: DiffRange): string {
  if (range.comparison === BASE_TIP_COMPARISON) return range.base
  return (
    getMergeBase(repoRoot, range.base, range.head) ??
    (() => {
      throw new Error(`git merge-base could not resolve ${range.base} and ${range.head}`)
    })()
  )
}

function isBrokenBase(state: PackageState): boolean {
  return state.exists && (state.version === undefined || !isCanonicalSemver(state.version))
}

function shortSha(value: string | undefined, fallback: string): string {
  return (value ?? fallback).slice(0, 7)
}

function baseOwnerLabel(baseRef: string): string {
  return baseRef === 'main' || baseRef.endsWith('/main') ? 'main' : baseRef
}

function commitSha(repoRoot: string, ref: string): string {
  return git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`]).trim()
}

function suggestion(base: string, head: string): string | undefined {
  if (!isCanonicalSemver(base) || !isCanonicalSemver(head)) return undefined
  const difference = semver.diff(base, head)
  return semver.inc(base, difference ?? 'minor') ?? undefined
}

export function runVersionSkewCheck(
  repoRoot: string,
  range: DiffRange,
  env: Partial<NodeJS.ProcessEnv> = process.env
): VersionSkewCheckResult {
  const baseResult = {
    changedContractFiles: [] as string[],
    baseRef: range.base,
    headRef: range.head,
  }
  let changedFiles: string[]
  try {
    changedFiles = getChangedFiles(repoRoot, range.base, range.head)
  } catch (error) {
    return {
      ...baseResult,
      verdict: { ok: false, code: UNRESOLVABLE_RANGE, detail: (error as Error).message },
    }
  }
  const changedContractFiles = changedFiles.filter(isContractFile)
  if (changedContractFiles.length === 0) {
    return {
      ...baseResult,
      changedContractFiles,
      verdict: { ok: true, reason: 'no-contract-change' },
    }
  }

  let baseRef = range.base
  try {
    baseRef = resolveComparisonBase(repoRoot, range)
    const baseState = packageStateAtRef(repoRoot, baseRef)
    const headState = packageStateAtRef(repoRoot, range.head)
    const allowBrokenBase = env.EXTENSION_API_SKEW_ALLOW_BROKEN_BASE === '1'
    const baseBroken = isBrokenBase(baseState)
    const verdict = detectVersionSkew({
      changedFiles,
      baseVersion: baseState.version,
      headVersion: headState.version,
      baseMissing: !baseState.exists,
      allowBrokenBase: baseBroken && allowBrokenBase,
    })
    return {
      ...baseResult,
      baseRef,
      changedContractFiles,
      baseSha: commitSha(repoRoot, baseRef),
      headSha: commitSha(repoRoot, range.head),
      baseVersion: baseState.version,
      headVersion: headState.version,
      verdict,
      ...(baseBroken && allowBrokenBase
        ? {
            baseWarning: `WARNING: the defect is on ${baseOwnerLabel(baseRef)} (${baseRef}), not in this PR; whoever can land a correction on ${baseOwnerLabel(baseRef)} must repair the malformed extension-api package.`,
          }
        : {}),
    }
  } catch (error) {
    return {
      ...baseResult,
      baseRef,
      changedContractFiles,
      verdict: { ok: false, code: UNRESOLVABLE_RANGE, detail: (error as Error).message },
    }
  }
}

function comparedLine(result: VersionSkewCheckResult): string {
  return `Compared base (${result.baseRef} @ ${shortSha(result.baseSha, result.baseRef)}) ${JSON.stringify(result.baseVersion)} with head (${result.headRef} @ ${shortSha(result.headSha, result.headRef)}) ${JSON.stringify(result.headVersion)}.`
}

function comparisonBlock(result: VersionSkewCheckResult): string {
  const literal = (value: string | undefined): string => value ?? 'undefined'
  const headLabel = result.headRef === HEAD_REF ? 'this branch / HEAD' : result.headRef
  return (
    `  base (${result.baseRef} @ ${shortSha(result.baseSha, result.baseRef)})  ${literal(result.baseVersion)}\n` +
    `  head (${headLabel} @ ${shortSha(result.headSha, result.headRef)})  ${literal(result.headVersion)}`
  )
}

function formatUnresolvableRange(result: VersionSkewCheckResult): string {
  const verdict = result.verdict
  if (verdict.code !== UNRESOLVABLE_RANGE) throw new Error('expected an unresolvable-range verdict')
  return (
    `FATAL: ${comparedLine(result)}\nWhy: the diff range is unresolvable. ${verdict.detail}\n` +
    'Fix: run this check from a non-shallow clone with a resolvable base ref (main for local runs).'
  )
}

function formatNoBump(result: VersionSkewCheckResult): string {
  const verdict = result.verdict
  if (verdict.code !== 'no-bump') throw new Error('expected a no-bump verdict')
  const next = suggestion(verdict.base, verdict.head)
  const suggested = next ?? 'a canonical version greater than the merge-base version'
  return (
    `FATAL: packages/extension-api contract files changed, but "version" is ${verdict.base} on both sides\n` +
    `       of this comparison.\n\n${comparisonBlock(result)}\n\n` +
    'Either this branch never bumped the version, or it bumped to a number another PR\n' +
    'merged to main first. Versions are allocated at MERGE, not at planning (Story 23.6).\n\n' +
    'Fix:\n  1. git fetch origin && git rebase origin/main\n' +
    `  2. Set "version" to ${suggested} in ${EXTENSION_API_PACKAGE_JSON}\n` +
    '     — the next free version as of this run; re-run after rebasing if main advances.\n' +
    `  3. Set EXTENSION_API_VERSION to ${suggested} in packages/extension-api/src/manifest.ts\n` +
    '     (these two must match — packages/extension-api/src/manifest.test.ts asserts it)'
  )
}

function formatDowngrade(result: VersionSkewCheckResult): string {
  const verdict = result.verdict
  if (verdict.code !== NOT_GREATER_THAN_MERGE_BASE)
    throw new Error('expected a not-greater-than-merge-base verdict')
  const next = suggestion(verdict.base, verdict.head)
  return (
    `${comparedLine(result)}\n` +
    `FATAL: the head version ${verdict.head} is not greater than the merge-base version ${verdict.base}.\n` +
    'This is a downgrade — for example, a revert. Versions roll forward, never backward: a revert of ' +
    `${verdict.base}'s changes ships as ${next ?? 'a greater canonical version'} (or a patch release), not as a return to an older version.\n` +
    `Fix: set the version field to a number greater than ${verdict.base}.`
  )
}

function formatInvalidSemver(result: VersionSkewCheckResult): string {
  const verdict = result.verdict
  if (verdict.code !== INVALID_SEMVER) throw new Error('expected an invalid-semver verdict')
  return (
    `${comparedLine(result)}\n` +
    `FATAL: ${verdict.which} version ${JSON.stringify(verdict.value)} is not canonical semver.\n` +
    'Fix: use an exact canonical version such as 1.2.0 (no v-prefix, shorthand, tag, or build-only change).'
  )
}

function formatMissingVersion(result: VersionSkewCheckResult): string {
  const verdict = result.verdict
  if (verdict.code !== MISSING_VERSION) throw new Error('expected a missing-version verdict')
  return (
    `${comparedLine(result)}\n` +
    `FATAL: the ${verdict.which} extension-api package has no readable canonical "version" field.\n` +
    `Fix: restore ${EXTENSION_API_PACKAGE_JSON} with a canonical version before running this check again.`
  )
}

function formatBaseDefectNotice(result: VersionSkewCheckResult): string {
  const verdict = result.verdict
  if (
    (verdict.code === INVALID_SEMVER || verdict.code === MISSING_VERSION) &&
    verdict.which === MERGE_BASE_COMPARISON
  ) {
    const owner = baseOwnerLabel(result.baseRef)
    return `FATAL: the defect is on ${owner}, not in this PR; whoever can land a correction on ${owner} must repair the malformed extension-api package.`
  }
  return ''
}

function formatFailure(result: VersionSkewCheckResult): string {
  const verdict = result.verdict
  const baseNotice = formatBaseDefectNotice(result)
  const detail =
    verdict.code === UNRESOLVABLE_RANGE
      ? formatUnresolvableRange(result)
      : verdict.code === 'no-bump'
        ? formatNoBump(result)
        : verdict.code === NOT_GREATER_THAN_MERGE_BASE
          ? formatDowngrade(result)
          : verdict.code === INVALID_SEMVER
            ? formatInvalidSemver(result)
            : formatMissingVersion(result)
  return baseNotice ? `${baseNotice}\n${detail}` : detail
}

export function report(result: VersionSkewCheckResult): void {
  if (result.verdict.ok) {
    if (result.baseWarning) process.stderr.write(`${result.baseWarning}\n`)
    process.stdout.write(`check-extension-api-version-skew: ${result.verdict.reason} — OK\n`)
    return
  }

  process.stderr.write(`${formatFailure(result)}\n`)
  for (const file of result.changedContractFiles) process.stderr.write(`  - ${file}\n`)
  process.stderr.write('\nReproduce locally: pnpm check-extension-api-version-skew\n')
  process.exitCode = 1
}

export function main(
  repoRoot: string = process.cwd(),
  env: Partial<NodeJS.ProcessEnv> = process.env
): void {
  report(runVersionSkewCheck(repoRoot, resolveDiffRange(env), env))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
}
