import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'
import {
  BUILD_INFO_FILES,
  DEV_BUILD_INFO,
  renderBuildInfoLine,
  stampBuildInfoSource,
} from './lib/build-info-template.js'
import { parseStampArgs, stampBuildInfo } from './stamp-build-info.js'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const makeFixtureRoot = useFixtureRoots('stamp-build-info-', ['packages'])

function copyCommittedBuildInfo(root: string): void {
  for (const file of BUILD_INFO_FILES) {
    writeFixture(root, file.path, readFileSync(join(repositoryRoot, file.path), 'utf8'))
  }
}

describe('renderBuildInfoLine', () => {
  it('renders the committed dev default', () => {
    expect(renderBuildInfoLine('CLI_BUILD_INFO', DEV_BUILD_INFO)).toBe(
      "export const CLI_BUILD_INFO: BuildInfo = { version: 'dev', commit: null }"
    )
  })

  it('renders a stamped release', () => {
    expect(renderBuildInfoLine('AGENT_BUILD_INFO', { version: '1.3.0', commit: '3f2a1c9' })).toBe(
      "export const AGENT_BUILD_INFO: BuildInfo = { version: '1.3.0', commit: '3f2a1c9' }"
    )
  })
})

describe('stampBuildInfoSource', () => {
  it('replaces exactly the constant line and nothing else', () => {
    const source = `// header\n${renderBuildInfoLine('X', DEV_BUILD_INFO)}\nexport const OTHER = 1\n`
    const stamped = stampBuildInfoSource(source, 'X', { version: '2.0.0', commit: 'abcdef0' })
    expect(stamped).toBe(
      `// header\nexport const X: BuildInfo = { version: '2.0.0', commit: 'abcdef0' }\nexport const OTHER = 1\n`
    )
  })

  it('throws when the constant line is missing', () => {
    expect(() => stampBuildInfoSource('export const Y = 1\n', 'X', DEV_BUILD_INFO)).toThrow(/X/)
  })
})

describe('parseStampArgs', () => {
  it('accepts zero components without leading zeros', () => {
    expect(parseStampArgs(['--version', '0.10.0', '--commit', '3f2a1c9']).version).toBe('0.10.0')
  })

  it('accepts a strict X.Y.Z version and a 7-char lowercase hex commit', () => {
    expect(parseStampArgs(['--version', '1.3.0', '--commit', '3f2a1c9'])).toEqual({
      version: '1.3.0',
      commit: '3f2a1c9',
    })
  })

  it.each([
    [['--version', 'v1.3.0', '--commit', '3f2a1c9']],
    [['--version', '1.3.0-rc.1', '--commit', '3f2a1c9']],
    [['--version', '1.3', '--commit', '3f2a1c9']],
    [['--version', '01.3.0', '--commit', '3f2a1c9']],
    [['--version', '1.03.0', '--commit', '3f2a1c9']],
    [['--version', '1.3.00', '--commit', '3f2a1c9']],
    [['--version', 'dev', '--commit', '3f2a1c9']],
    [['--version', '1.3.0', '--commit', '3F2A1C9']],
    [['--version', '1.3.0', '--commit', '3f2a1c90']],
    [['--version', '1.3.0', '--commit', 'zzzzzzz']],
    [['--version', '1.3.0']],
    [['--commit', '3f2a1c9']],
    [[]],
  ])('rejects %j', (argv) => {
    expect(() => parseStampArgs(argv)).toThrow()
  })
})

describe('stampBuildInfo', () => {
  it('stamps both the agent and the cli build-info files with identical values', () => {
    const root = makeFixtureRoot()
    copyCommittedBuildInfo(root)
    stampBuildInfo(root, { version: '1.3.0', commit: '3f2a1c9' })
    for (const file of BUILD_INFO_FILES) {
      const content = readFileSync(join(root, file.path), 'utf8')
      expect(content).toContain(
        renderBuildInfoLine(file.constName, { version: '1.3.0', commit: '3f2a1c9' })
      )
      expect(content).not.toContain("version: 'dev'")
    }
  })

  it('never touches any package.json', () => {
    const root = makeFixtureRoot()
    copyCommittedBuildInfo(root)
    writeFixture(root, 'packages/cli/package.json', '{"version":"0.0.1"}')
    stampBuildInfo(root, { version: '1.3.0', commit: '3f2a1c9' })
    expect(readFileSync(join(root, 'packages/cli/package.json'), 'utf8')).toBe(
      '{"version":"0.0.1"}'
    )
  })
})
