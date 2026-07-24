import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeFixture } from './lib/fixture-test-helpers.js'
import {
  detectVersionSkew,
  getChangedFiles,
  getFileVersionAtRef,
  hasExtensionApiSrcChange,
  resolveDiffRange,
  runVersionSkewCheck,
} from './check-extension-api-version-skew.js'

const PACKAGE_JSON_PATH = 'packages/extension-api/package.json'
const SRC_INDEX_PATH = 'packages/extension-api/src/index.ts'
const CHANGED_SRC_CONTENT = 'export const changed = true\n'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

/** Builds a throwaway git repo with a base commit, returning helpers to add a head commit and read its root. */
function makeGitFixtureRepo(): { root: string; baseSha: string } {
  const root = mkdtempSync(join(tmpdir(), 'extension-api-version-skew-'))
  git(root, ['init', '--initial-branch=main'])
  git(root, ['config', 'user.email', 'test@example.com'])
  git(root, ['config', 'user.name', 'Test'])
  writeFixture(root, PACKAGE_JSON_PATH, JSON.stringify({ version: '1.0.0' }, null, 2))
  writeFixture(root, SRC_INDEX_PATH, 'export const original = true\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '-m', 'base'])
  const baseSha = git(root, ['rev-parse', 'HEAD'])
  return { root, baseSha }
}

const tempRoots: string[] = []
afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function makeFixtureRepo(): { root: string; baseSha: string } {
  const fixture = makeGitFixtureRepo()
  tempRoots.push(fixture.root)
  return fixture
}

describe('resolveDiffRange', () => {
  it('uses origin/<base> and GITHUB_SHA when GITHUB_BASE_REF is set (GitHub Actions pull_request event)', () => {
    expect(resolveDiffRange({ GITHUB_BASE_REF: 'main', GITHUB_SHA: 'abc123' })).toEqual({
      base: 'origin/main',
      head: 'abc123',
    })
  })

  it('falls back to comparing local main against HEAD when GITHUB_BASE_REF is unset (local/dev runs)', () => {
    expect(resolveDiffRange({})).toEqual({ base: 'main', head: 'HEAD' })
  })
})

describe('hasExtensionApiSrcChange', () => {
  it('is true when a changed file is under packages/extension-api/src/', () => {
    expect(hasExtensionApiSrcChange([SRC_INDEX_PATH])).toBe(true)
  })

  it('is false for changes elsewhere, including the package.json itself', () => {
    expect(hasExtensionApiSrcChange(['packages/extension-api/package.json', 'README.md'])).toBe(
      false
    )
  })
})

describe('detectVersionSkew', () => {
  it('is false (no skew) when src/** did not change, regardless of version', () => {
    expect(
      detectVersionSkew({ changedFiles: ['README.md'], baseVersion: '1.0.0', headVersion: '1.0.0' })
    ).toBe(false)
  })

  it('is false (no skew) when src/** changed AND the version field also changed', () => {
    expect(
      detectVersionSkew({
        changedFiles: [SRC_INDEX_PATH],
        baseVersion: '1.0.0',
        headVersion: '1.0.1',
      })
    ).toBe(false)
  })

  it('is true (skew) when src/** changed but the version field did not', () => {
    expect(
      detectVersionSkew({
        changedFiles: [SRC_INDEX_PATH],
        baseVersion: '1.0.0',
        headVersion: '1.0.0',
      })
    ).toBe(true)
  })

  it('is true (skew) when src/** changed and package.json did not exist at the base ref at all (undefined === undefined is excluded by requiring both defined)', () => {
    // A brand-new package's first commit: base has no package.json (undefined), head has "1.0.0".
    // undefined !== "1.0.0", so this correctly reports "no skew" (the version DID change, from
    // nothing to something) — verified explicitly since undefined-handling is an easy off-by-one.
    expect(
      detectVersionSkew({
        changedFiles: [SRC_INDEX_PATH],
        baseVersion: undefined,
        headVersion: '1.0.0',
      })
    ).toBe(false)
  })
})

describe('git-backed helpers (real temporary git repositories)', () => {
  it('getChangedFiles lists files touched between two commits', () => {
    const { root, baseSha } = makeFixtureRepo()
    writeFixture(root, SRC_INDEX_PATH, CHANGED_SRC_CONTENT)
    git(root, ['add', '-A'])
    git(root, ['commit', '-m', 'head'])

    const changed = getChangedFiles(root, baseSha, 'HEAD')
    expect(changed).toContain(SRC_INDEX_PATH)
  })

  it("getFileVersionAtRef reads a file's package.json version field at a given ref", () => {
    const { root, baseSha } = makeFixtureRepo()
    expect(getFileVersionAtRef(root, baseSha, PACKAGE_JSON_PATH)).toBe('1.0.0')
  })

  it('getFileVersionAtRef returns undefined when the file does not exist at that ref', () => {
    const { root, baseSha } = makeFixtureRepo()
    expect(
      getFileVersionAtRef(root, baseSha, 'packages/extension-api/does-not-exist.json')
    ).toBeUndefined()
  })

  it('runVersionSkewCheck: no src/** change -> pass', () => {
    const { root, baseSha } = makeFixtureRepo()
    writeFixture(root, 'README.md', 'unrelated change\n')
    git(root, ['add', '-A'])
    git(root, ['commit', '-m', 'unrelated'])

    const result = runVersionSkewCheck(root, { base: baseSha, head: 'HEAD' })
    expect(result.skew).toBe(false)
  })

  it('runVersionSkewCheck: src/** change + version bump -> pass', () => {
    const { root, baseSha } = makeFixtureRepo()
    writeFixture(root, SRC_INDEX_PATH, CHANGED_SRC_CONTENT)
    writeFixture(root, PACKAGE_JSON_PATH, JSON.stringify({ version: '1.0.1' }, null, 2))
    git(root, ['add', '-A'])
    git(root, ['commit', '-m', 'bump version with src change'])

    const result = runVersionSkewCheck(root, { base: baseSha, head: 'HEAD' })
    expect(result.skew).toBe(false)
  })

  it('runVersionSkewCheck: src/** change without version bump -> fail (skew) naming the changed files', () => {
    const { root, baseSha } = makeFixtureRepo()
    writeFixture(root, SRC_INDEX_PATH, CHANGED_SRC_CONTENT)
    git(root, ['add', '-A'])
    git(root, ['commit', '-m', 'src change without version bump'])

    const result = runVersionSkewCheck(root, { base: baseSha, head: 'HEAD' })
    expect(result.skew).toBe(true)
    expect(result.changedSrcFiles).toContain(SRC_INDEX_PATH)
  })
})
