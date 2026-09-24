import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'
import { BUILD_INFO_FILES } from './lib/build-info-template.js'
import { findStampedBuildInfo } from './check-build-info-unstamped.js'
import { stampBuildInfo } from './stamp-build-info.js'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI_BUILD_INFO = 'packages/cli/src/build-info.ts'
const makeFixtureRoot = useFixtureRoots('check-build-info-unstamped-', ['packages'])

function copyCommittedBuildInfo(root: string): void {
  for (const file of BUILD_INFO_FILES) {
    writeFixture(root, file.path, readFileSync(join(repositoryRoot, file.path), 'utf8'))
  }
}

describe('check-build-info-unstamped', () => {
  it('the committed repository build-info files hold the dev/null defaults', () => {
    expect(findStampedBuildInfo(repositoryRoot)).toEqual([])
  })

  it('flags both files after a local stamp', () => {
    const root = makeFixtureRoot()
    copyCommittedBuildInfo(root)
    stampBuildInfo(root, { version: '1.3.0', commit: '3f2a1c9' })
    const problems = findStampedBuildInfo(root)
    expect(problems).toHaveLength(2)
    expect(problems.join('\n')).toContain('packages/agent/src/build-info.ts')
    expect(problems.join('\n')).toContain(CLI_BUILD_INFO)
  })

  it('flags a hand-edited commit even when the version is still dev', () => {
    const root = makeFixtureRoot()
    copyCommittedBuildInfo(root)
    const cliPath = join(root, CLI_BUILD_INFO)
    writeFixture(
      root,
      CLI_BUILD_INFO,
      readFileSync(cliPath, 'utf8').replace('commit: null', "commit: 'abcdef0'")
    )
    expect(findStampedBuildInfo(root)).toEqual([expect.stringContaining(CLI_BUILD_INFO)])
  })

  it('flags a missing file', () => {
    const root = makeFixtureRoot()
    expect(findStampedBuildInfo(root)).toHaveLength(2)
  })
})
