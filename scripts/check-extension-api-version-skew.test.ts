/* eslint-disable sonarjs/no-duplicate-string */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeFixture } from './lib/fixture-test-helpers.js'
import {
  CONTRACT_FILES,
  CONTRACT_PATHS,
  EXCLUDED_PATTERNS,
  detectVersionSkew,
  getChangedFiles,
  getFileVersionAtRef,
  hasExtensionApiSrcChange,
  main,
  report,
  resolveDiffRange,
  runVersionSkewCheck,
} from './check-extension-api-version-skew.js'

const PACKAGE_JSON_PATH = 'packages/extension-api/package.json'
const SRC_INDEX_PATH = 'packages/extension-api/src/index.ts'
const LOADER_PATH = 'apps/api/src/extensions/loader.ts'
const CHANGED_SRC_CONTENT = 'export const changed = true\n'
const tempRoots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

function commit(cwd: string, message: string): string {
  git(cwd, ['add', '-A'])
  git(cwd, ['commit', '-m', message])
  return git(cwd, ['rev-parse', 'HEAD'])
}

function writePackage(root: string, version: string | undefined): void {
  if (version === undefined) {
    rmSync(join(root, PACKAGE_JSON_PATH), { force: true })
    return
  }
  writeFixture(root, PACKAGE_JSON_PATH, JSON.stringify({ version }, null, 2))
}

/** Builds a throwaway git repo with a base commit, returning helpers to add a head commit and read its root. */
function makeGitFixtureRepo(options: { withPackage?: boolean } = {}): {
  root: string
  baseSha: string
} {
  const root = mkdtempSync(join(tmpdir(), 'extension-api-version-skew-'))
  tempRoots.push(root)
  git(root, ['init', '--initial-branch=main'])
  git(root, ['config', 'user.email', 'test@invalid'])
  git(root, ['config', 'user.name', 'Test'])
  if (options.withPackage !== false) writePackage(root, '1.0.0')
  writeFixture(root, SRC_INDEX_PATH, 'export const original = true\n')
  const baseSha = commit(root, 'base')
  return { root, baseSha }
}

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('resolveDiffRange', () => {
  it('uses the target branch tip for a pull request', () => {
    expect(resolveDiffRange({ GITHUB_BASE_REF: 'main', GITHUB_SHA: 'abc123' })).toEqual({
      base: 'origin/main',
      head: 'abc123',
      comparison: 'base-tip',
    })
  })

  it('uses the first parent for a push event', () => {
    expect(resolveDiffRange({ GITHUB_EVENT_NAME: 'push', GITHUB_SHA: 'abc123' })).toEqual({
      base: 'HEAD^1',
      head: 'abc123',
      comparison: 'base-tip',
    })
  })

  it('uses a merge-base for local runs', () => {
    expect(resolveDiffRange({})).toEqual({ base: 'main', head: 'HEAD', comparison: 'merge-base' })
  })
})

describe('contract trigger data', () => {
  it('documents the path, exact-file, and basename exclusion rules', () => {
    expect(CONTRACT_PATHS).toContain('packages/extension-api/src/')
    expect(CONTRACT_FILES).toContain(LOADER_PATH)
    expect(EXCLUDED_PATTERNS).toHaveLength(1)
    expect(EXCLUDED_PATTERNS[0].test('loader.test.ts')).toBe(true)
  })

  it('excludes tests from both prefix and exact-file matches', () => {
    expect(hasExtensionApiSrcChange([SRC_INDEX_PATH])).toBe(true)
    expect(hasExtensionApiSrcChange(['packages/extension-api/src/index.test.ts'])).toBe(false)
    expect(hasExtensionApiSrcChange([LOADER_PATH])).toBe(true)
    expect(hasExtensionApiSrcChange(['apps/api/src/extensions/loader.test.ts'])).toBe(false)
    expect(hasExtensionApiSrcChange(['packages/extension-api/package.json', 'README.md'])).toBe(
      false
    )
  })

  it('does not let a test file launder a no-bump source change', () => {
    const result = runDetect(
      [SRC_INDEX_PATH, 'packages/extension-api/src/index.test.ts'],
      '1.0.0',
      '1.0.0'
    )
    expect(result).toEqual({ ok: false, code: 'no-bump', base: '1.0.0', head: '1.0.0' })
  })
})

function runDetect(
  changedFiles: string[],
  baseVersion: string | undefined,
  headVersion: string | undefined,
  rangeError?: string,
  options?: { baseMissing?: boolean }
) {
  return detectVersionSkew({
    changedFiles,
    baseVersion,
    headVersion,
    rangeError,
    baseMissing: options?.baseMissing,
  })
}

describe('detectVersionSkew', () => {
  it('returns no-contract-change without inspecting versions', () => {
    expect(runDetect(['README.md'], 'banana', undefined)).toEqual({
      ok: true,
      reason: 'no-contract-change',
    })
  })

  it('returns valid-increase for patch, minor, major, and higher-version prerelease bumps', () => {
    for (const [base, head] of [
      ['1.0.0', '1.0.1'],
      ['1.0.0', '1.1.0'],
      ['1.0.0', '2.0.0'],
      ['1.0.0', '1.1.0-rc.1'],
    ]) {
      expect(runDetect([SRC_INDEX_PATH], base, head)).toEqual({
        ok: true,
        reason: 'valid-increase',
        from: base,
        to: head,
      })
    }
  })

  it.each([
    ['1.0.0', '1.0.0', { ok: false, code: 'no-bump', base: '1.0.0', head: '1.0.0' }],
    [
      '1.1.0',
      '1.0.0',
      { ok: false, code: 'not-greater-than-merge-base', base: '1.1.0', head: '1.0.0' },
    ],
    [
      '1.0.0',
      '1.0.0-rc.1',
      { ok: false, code: 'not-greater-than-merge-base', base: '1.0.0', head: '1.0.0-rc.1' },
    ],
    [
      '1.0.0',
      '1.0.0+build.5',
      { ok: false, code: 'invalid-semver', which: 'head', value: '1.0.0+build.5' },
    ],
  ])('rejects non-increasing versions: %s -> %s', (base, head, expected) => {
    expect(runDetect([SRC_INDEX_PATH], base, head)).toEqual(expected)
  })

  it.each(['banana', '', 'v1.0.0', '1.0', 'latest'])('rejects non-canonical head %s', (head) => {
    expect(runDetect([SRC_INDEX_PATH], '1.0.0', head)).toEqual({
      ok: false,
      code: 'invalid-semver',
      which: 'head',
      value: head,
    })
  })

  it('reports missing head before missing or invalid merge-base', () => {
    expect(runDetect([SRC_INDEX_PATH], undefined, undefined)).toEqual({
      ok: false,
      code: 'missing-version',
      which: 'head',
    })
    expect(runDetect([SRC_INDEX_PATH], 'banana', undefined)).toEqual({
      ok: false,
      code: 'missing-version',
      which: 'head',
    })
  })

  it('reports invalid head before invalid merge-base', () => {
    expect(runDetect([SRC_INDEX_PATH], 'banana', 'v1.0.0')).toEqual({
      ok: false,
      code: 'invalid-semver',
      which: 'head',
      value: 'v1.0.0',
    })
  })

  it('reports the range failure before version failures', () => {
    expect(runDetect([SRC_INDEX_PATH], '1.0.0', '1.0.0', 'git diff failed: bad ref')).toEqual({
      ok: false,
      code: 'unresolvable-range',
      detail: 'git diff failed: bad ref',
    })
  })

  it('classifies a valid new package positively', () => {
    expect(
      runDetect([SRC_INDEX_PATH], undefined, '1.0.0', undefined, { baseMissing: true })
    ).toEqual({
      ok: true,
      reason: 'new-package',
      to: '1.0.0',
    })
  })

  it('rejects a malformed first version instead of treating it as a new package', () => {
    expect(
      runDetect([SRC_INDEX_PATH], undefined, 'banana', undefined, { baseMissing: true })
    ).toEqual({
      ok: false,
      code: 'invalid-semver',
      which: 'head',
      value: 'banana',
    })
  })
})

describe('git-backed helpers (real temporary git repositories)', () => {
  it('lists changed files between two commits', () => {
    const { root, baseSha } = makeGitFixtureRepo()
    writeFixture(root, SRC_INDEX_PATH, CHANGED_SRC_CONTENT)
    commit(root, 'head')
    expect(getChangedFiles(root, baseSha, 'HEAD')).toContain(SRC_INDEX_PATH)
  })

  it('reads a package version and returns undefined for an absent file', () => {
    const { root, baseSha } = makeGitFixtureRepo()
    expect(getFileVersionAtRef(root, baseSha, PACKAGE_JSON_PATH)).toBe('1.0.0')
    expect(getFileVersionAtRef(root, baseSha, 'missing.json')).toBeUndefined()
  })

  it('skips all git show version reads when no contract file changed', () => {
    const { root, baseSha } = makeGitFixtureRepo()
    writeFixture(root, 'README.md', 'unrelated change\n')
    commit(root, 'unrelated')
    expect(
      runVersionSkewCheck(root, { base: baseSha, head: 'HEAD', comparison: 'base-tip' }).verdict
    ).toEqual({
      ok: true,
      reason: 'no-contract-change',
    })
  })

  it('passes a valid increase and fails a no-bump with only contract files in the report', () => {
    const { root, baseSha } = makeGitFixtureRepo()
    writeFixture(root, SRC_INDEX_PATH, CHANGED_SRC_CONTENT)
    writeFixture(root, 'packages/extension-api/src/index.test.ts', 'test changed\n')
    writePackage(root, '1.0.1')
    commit(root, 'bump')
    expect(
      runVersionSkewCheck(root, { base: baseSha, head: 'HEAD', comparison: 'base-tip' }).verdict
    ).toEqual({
      ok: true,
      reason: 'valid-increase',
      from: '1.0.0',
      to: '1.0.1',
    })

    writeFixture(root, SRC_INDEX_PATH, 'changed again\n')
    writePackage(root, '1.0.0')
    const headSha = commit(root, 'no bump')
    const result = runVersionSkewCheck(root, {
      base: baseSha,
      head: headSha,
      comparison: 'base-tip',
    })
    expect(result.verdict).toEqual({ ok: false, code: 'no-bump', base: '1.0.0', head: '1.0.0' })
    expect(result.changedContractFiles).toEqual([SRC_INDEX_PATH])
  })

  it('establishes the new-package case from a missing base file', () => {
    const { root, baseSha } = makeGitFixtureRepo({ withPackage: false })
    writePackage(root, '1.0.0')
    writeFixture(root, SRC_INDEX_PATH, CHANGED_SRC_CONTENT)
    commit(root, 'new package')
    expect(
      runVersionSkewCheck(root, { base: baseSha, head: 'HEAD', comparison: 'base-tip' }).verdict
    ).toEqual({
      ok: true,
      reason: 'new-package',
      to: '1.0.0',
    })
  })

  it('rejects a missing head package and a malformed base package', () => {
    const { root, baseSha } = makeGitFixtureRepo()
    writeFixture(root, SRC_INDEX_PATH, CHANGED_SRC_CONTENT)
    writePackage(root, undefined)
    const missingHead = commit(root, 'remove package')
    expect(
      runVersionSkewCheck(root, { base: baseSha, head: missingHead, comparison: 'base-tip' })
        .verdict
    ).toEqual({
      ok: false,
      code: 'missing-version',
      which: 'head',
    })

    const malformed = makeGitFixtureRepo()
    writeFixture(malformed.root, PACKAGE_JSON_PATH, '{not json\n')
    const malformedBase = commit(malformed.root, 'malformed base')
    writeFixture(malformed.root, SRC_INDEX_PATH, CHANGED_SRC_CONTENT)
    writePackage(malformed.root, '1.0.1')
    const malformedHead = commit(malformed.root, 'head')
    expect(
      runVersionSkewCheck(malformed.root, {
        base: malformedBase,
        head: malformedHead,
        comparison: 'base-tip',
      }).verdict
    ).toEqual({
      ok: false,
      code: 'missing-version',
      which: 'merge-base',
    })
  })

  it('allows a broken base only through the reviewed escape hatch, never for a broken head', () => {
    const { root, baseSha } = makeGitFixtureRepo()
    writeFixture(root, PACKAGE_JSON_PATH, '{not json\n')
    const brokenBase = commit(root, 'broken base')
    writeFixture(root, SRC_INDEX_PATH, CHANGED_SRC_CONTENT)
    writePackage(root, '1.0.1')
    const head = commit(root, 'head')
    const range = { base: brokenBase, head, comparison: 'base-tip' as const }
    expect(runVersionSkewCheck(root, range).verdict).toEqual({
      ok: false,
      code: 'missing-version',
      which: 'merge-base',
    })
    expect(
      runVersionSkewCheck(root, range, { EXTENSION_API_SKEW_ALLOW_BROKEN_BASE: '1' }).verdict
    ).toEqual({
      ok: true,
      reason: 'new-package',
      to: '1.0.1',
    })

    writePackage(root, 'banana')
    const badHead = commit(root, 'bad head')
    expect(
      runVersionSkewCheck(
        root,
        { base: brokenBase, head: badHead, comparison: 'base-tip' },
        {
          EXTENSION_API_SKEW_ALLOW_BROKEN_BASE: '1',
        }
      ).verdict
    ).toEqual({ ok: false, code: 'invalid-semver', which: 'head', value: 'banana' })
    expect(baseSha).toBeTypeOf('string')
  })

  it('allows a malformed base version only through the reviewed escape hatch', () => {
    const { root } = makeGitFixtureRepo()
    writePackage(root, 'banana')
    const brokenBase = commit(root, 'invalid base')
    writeFixture(root, SRC_INDEX_PATH, CHANGED_SRC_CONTENT)
    writePackage(root, '1.0.1')
    const head = commit(root, 'valid head')
    const range = { base: brokenBase, head, comparison: 'base-tip' as const }
    expect(runVersionSkewCheck(root, range).verdict).toEqual({
      ok: false,
      code: 'invalid-semver',
      which: 'merge-base',
      value: 'banana',
    })
    const escaped = runVersionSkewCheck(root, range, {
      EXTENSION_API_SKEW_ALLOW_BROKEN_BASE: '1',
    })
    expect(escaped.verdict).toEqual({ ok: true, reason: 'new-package', to: '1.0.1' })
    expect(escaped.baseWarning).toContain(`defect is on ${brokenBase}`)
  })

  it('returns unresolvable-range with the git error instead of passing', () => {
    const { root } = makeGitFixtureRepo()
    const result = runVersionSkewCheck(root, {
      base: 'does-not-exist',
      head: 'HEAD',
      comparison: 'base-tip',
    })
    expect(result.verdict.ok).toBe(false)
    expect(result.verdict).toMatchObject({ code: 'unresolvable-range' })
    expect((result.verdict as { detail: string }).detail).toMatch(/does-not-exist/)
  })

  it('sets the CLI exit code for an unresolvable range', () => {
    const { root } = makeGitFixtureRepo()
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    main(root, { GITHUB_BASE_REF: 'does-not-exist', GITHUB_SHA: 'HEAD' })

    expect(process.exitCode).toBe(1)
    expect(stderr.mock.calls.map(([value]) => String(value)).join('')).toContain('unresolvable')
  })

  it('handles a direct push to main with HEAD^1 and fails a no-bump', () => {
    const { root } = makeGitFixtureRepo()
    writeFixture(root, SRC_INDEX_PATH, CHANGED_SRC_CONTENT)
    const head = commit(root, 'direct push without bump')
    expect(
      runVersionSkewCheck(root, { base: 'HEAD^1', head, comparison: 'base-tip' }).verdict
    ).toEqual({
      ok: false,
      code: 'no-bump',
      base: '1.0.0',
      head: '1.0.0',
    })
  })

  it('handles a merge commit on main before the direct-push no-bump case', () => {
    const { root, baseSha } = makeGitFixtureRepo()
    git(root, ['checkout', '-b', 'validated-pr', baseSha])
    writeFixture(root, SRC_INDEX_PATH, CHANGED_SRC_CONTENT)
    writePackage(root, '1.0.1')
    const prHead = commit(root, 'validated PR')
    git(root, ['checkout', 'main'])
    git(root, ['merge', '--no-ff', prHead, '-m', 'merge validated PR'])
    const mergeHead = git(root, ['rev-parse', 'HEAD'])
    expect(
      runVersionSkewCheck(root, { base: 'HEAD^1', head: mergeHead, comparison: 'base-tip' }).verdict
    ).toEqual({
      ok: true,
      reason: 'valid-increase',
      from: '1.0.0',
      to: '1.0.1',
    })
  })

  it('handles a push to dev without a local main branch', () => {
    const { root } = makeGitFixtureRepo()
    git(root, ['branch', '-m', 'dev'])
    writeFixture(root, SRC_INDEX_PATH, CHANGED_SRC_CONTENT)
    writePackage(root, '1.0.1')
    const head = commit(root, 'dev push')
    expect(
      runVersionSkewCheck(root, { base: 'HEAD^1', head, comparison: 'base-tip' }).verdict.ok
    ).toBe(true)
  })

  it('rejects a root commit because HEAD^1 cannot resolve', () => {
    const root = mkdtempSync(join(tmpdir(), 'extension-api-version-skew-root-'))
    tempRoots.push(root)
    git(root, ['init', '--initial-branch=main'])
    git(root, ['config', 'user.email', 'test@invalid'])
    git(root, ['config', 'user.name', 'Test'])
    writeFixture(root, SRC_INDEX_PATH, CHANGED_SRC_CONTENT)
    const head = commit(root, 'root')
    expect(
      runVersionSkewCheck(root, { base: 'HEAD^1', head, comparison: 'base-tip' }).verdict
    ).toMatchObject({
      ok: false,
      code: 'unresolvable-range',
    })
  })

  it('characterises the two-branch collision for PR and local fork-point ranges', () => {
    const { root, baseSha } = makeGitFixtureRepo()
    git(root, ['checkout', '-b', 's233', baseSha])
    writeFixture(
      root,
      'packages/extension-api/src/hooks/capability-gate.ts',
      'export const gate = true\n'
    )
    writePackage(root, '1.1.0')
    const s233 = commit(root, 's233 bump')
    git(root, ['checkout', 'main'])
    git(root, ['merge', '--no-ff', s233, '-m', 'merge s233'])
    const mainTip = git(root, ['rev-parse', 'HEAD'])
    git(root, ['checkout', '-b', 's232', baseSha])
    writeFixture(
      root,
      'packages/extension-api/src/hooks/auth-strategy.ts',
      'export const auth = true\n'
    )
    writePackage(root, '1.1.0')
    let s232 = commit(root, 's232 colliding bump')

    expect(
      runVersionSkewCheck(root, { base: mainTip, head: s232, comparison: 'base-tip' }).verdict
    ).toEqual({
      ok: false,
      code: 'no-bump',
      base: '1.1.0',
      head: '1.1.0',
    })
    expect(
      runVersionSkewCheck(root, { base: baseSha, head: s232, comparison: 'base-tip' }).verdict
    ).toEqual({
      ok: true,
      reason: 'valid-increase',
      from: '1.0.0',
      to: '1.1.0',
    })

    writePackage(root, '1.2.0')
    s232 = commit(root, 's232 reconciled bump')
    expect(
      runVersionSkewCheck(root, { base: mainTip, head: s232, comparison: 'base-tip' }).verdict
    ).toEqual({
      ok: true,
      reason: 'valid-increase',
      from: '1.1.0',
      to: '1.2.0',
    })
    expect(
      runVersionSkewCheck(root, { base: baseSha, head: s232, comparison: 'base-tip' }).verdict
    ).toEqual({
      ok: true,
      reason: 'valid-increase',
      from: '1.0.0',
      to: '1.2.0',
    })
  })
})

describe('report', () => {
  it('explains a no-bump with refs, literals, a provisional next version, and reproduction', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    report({
      verdict: { ok: false, code: 'no-bump', base: '1.1.0', head: '1.1.0' },
      changedContractFiles: [LOADER_PATH],
      baseRef: 'origin/main',
      headRef: 'HEAD',
      baseSha: 'def5678abcdef',
      headSha: 'abc1234abcdef',
    })
    const output = stderr.mock.calls.map(([value]) => String(value)).join('')
    expect(output).toContain('1.2.0')
    expect(output).toContain('as of this run')
    expect(output).toContain('EXTENSION_API_VERSION')
    expect(output).toContain('packages/extension-api/src/manifest.ts')
    expect(output).toContain('Reproduce locally: pnpm check-extension-api-version-skew')
  })

  it('gives downgrade/revert guidance', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    report({
      verdict: { ok: false, code: 'not-greater-than-merge-base', base: '1.1.0', head: '1.0.1' },
      changedContractFiles: [SRC_INDEX_PATH],
      baseRef: 'main',
      headRef: 'HEAD',
      baseSha: 'def5678',
      headSha: 'abc1234',
    })
    const output = stderr.mock.calls.map(([value]) => String(value)).join('')
    expect(output).toContain('a downgrade')
    expect(output).toContain('for example, a revert')
    expect(output).toContain('Reproduce locally: pnpm check-extension-api-version-skew')
  })

  it('identifies a broken merge-base as a main-side defect before remediation guidance', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    report({
      verdict: { ok: false, code: 'invalid-semver', which: 'merge-base', value: 'banana' },
      changedContractFiles: [SRC_INDEX_PATH],
      baseRef: 'origin/main',
      headRef: 'HEAD',
      baseSha: 'def5678',
      headSha: 'abc1234',
    })
    const output = stderr.mock.calls.map(([value]) => String(value)).join('')
    expect(output.startsWith('FATAL: the defect is on main, not in this PR')).toBe(true)
    expect(output).toContain('whoever can land a correction on main')
  })
})

describe('dependency and wiring contracts', () => {
  it('keeps the root semver range aligned with the extension package baseline', () => {
    const rootPackage = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      devDependencies: { semver?: string }
    }
    const extensionPackage = JSON.parse(
      readFileSync(join(process.cwd(), 'packages/extension-api/package.json'), 'utf8')
    ) as { dependencies: { semver?: string } }
    expect(rootPackage.devDependencies.semver).toBe('^7.8.5')
    expect(extensionPackage.dependencies.semver).toBe('7.8.5')
    expect(rootPackage.devDependencies.semver?.replace('^', '')).toBe(
      extensionPackage.dependencies.semver
    )
  })

  it('wires this suite in both CI call sites and cites Story 24.4', () => {
    const ci = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8')
    const makefile = readFileSync(join(process.cwd(), 'Makefile'), 'utf8')
    expect(ci).toContain('Check extension-api version-skew (Story 14.1 AC7 / Story 24.4)')
    expect(ci).toContain('pnpm vitest run scripts/check-extension-api-version-skew.test.ts')
    expect(makefile).toContain('pnpm vitest run scripts/check-extension-api-version-skew.test.ts')
    expect(makefile).toContain('pnpm check-extension-api-version-skew')
  })
})
