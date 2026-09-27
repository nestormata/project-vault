import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'
import { resolveBin } from './lib/trusted-executable.js'
import {
  buildFreshDist,
  compareDistDirectories,
  listFilesRecursively,
} from './check-vault-action-dist-fresh.js'

const execFileSyncMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: execFileSyncMock,
}))

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const makeFixtureRoot = useFixtureRoots('vault-action-dist-fresh-', ['committed', 'fresh'])
const dirs = (root: string) => [`${root}/committed`, `${root}/fresh`] as const

const INDEX_JS = 'index.js'
const COMMITTED_INDEX_JS = `committed/${INDEX_JS}`
const FRESH_INDEX_JS = `fresh/${INDEX_JS}`
const SAMPLE_CONTENT = 'console.log(1)'

describe('listFilesRecursively', () => {
  it('lists nested files relative to the given root, sorted', () => {
    const root = makeFixtureRoot()
    writeFixture(root, COMMITTED_INDEX_JS, 'a')
    writeFixture(root, 'committed/nested/index.js.map', 'b')

    expect(listFilesRecursively(`${root}/committed`)).toEqual([INDEX_JS, 'nested/index.js.map'])
  })

  it('returns an empty array for a directory that does not exist', () => {
    const root = makeFixtureRoot()
    expect(listFilesRecursively(`${root}/does-not-exist`)).toEqual([])
  })
})

describe('compareDistDirectories', () => {
  it('reports no diffs when both directories are byte-identical', () => {
    const root = makeFixtureRoot()
    writeFixture(root, COMMITTED_INDEX_JS, SAMPLE_CONTENT)
    writeFixture(root, FRESH_INDEX_JS, SAMPLE_CONTENT)

    expect(compareDistDirectories(...dirs(root))).toEqual([])
  })

  it('flags a file whose content differs between the two directories', () => {
    const root = makeFixtureRoot()
    writeFixture(root, COMMITTED_INDEX_JS, SAMPLE_CONTENT)
    writeFixture(root, FRESH_INDEX_JS, 'console.log(2)')

    const diffs = compareDistDirectories(...dirs(root))
    expect(diffs).toEqual([
      `${INDEX_JS}: content differs between the committed dist/ and a fresh rebuild`,
    ])
  })

  it('flags a file present in the fresh rebuild but missing from the committed dist/ (e.g. after adding a new source file)', () => {
    const root = makeFixtureRoot()
    writeFixture(root, COMMITTED_INDEX_JS, SAMPLE_CONTENT)
    writeFixture(root, FRESH_INDEX_JS, SAMPLE_CONTENT)
    writeFixture(root, 'fresh/index.js.map', '{}')

    const diffs = compareDistDirectories(...dirs(root))
    expect(diffs).toEqual([
      'index.js.map: present in a fresh rebuild but missing from the committed dist/',
    ])
  })

  it('flags a file present in the committed dist/ but missing from a fresh rebuild (e.g. a stale leftover)', () => {
    const root = makeFixtureRoot()
    writeFixture(root, COMMITTED_INDEX_JS, SAMPLE_CONTENT)
    writeFixture(root, 'committed/stale.txt', 'leftover')
    writeFixture(root, FRESH_INDEX_JS, SAMPLE_CONTENT)

    const diffs = compareDistDirectories(...dirs(root))
    expect(diffs).toEqual([
      'stale.txt: present in the committed dist/ but missing from a fresh rebuild',
    ])
  })

  it('reports every difference found, not just the first', () => {
    const root = makeFixtureRoot()
    writeFixture(root, COMMITTED_INDEX_JS, SAMPLE_CONTENT)
    writeFixture(root, 'committed/stale.txt', 'leftover')
    writeFixture(root, FRESH_INDEX_JS, 'console.log(2)')
    writeFixture(root, 'fresh/new.txt', 'new')

    const diffs = compareDistDirectories(...dirs(root))
    expect(diffs).toHaveLength(3)
  })
})

// Story 43.9 AC-4 (typescript:S4036): no `pnpm` subprocess. The workspace-local tsc/ncc bins run
// under the Node that is already executing, with ncc's arguments byte-identical to the old
// `pnpm --filter @project-vault/vault-action exec ncc ...` invocation.
describe('buildFreshDist', () => {
  it('runs the agent build (tsc) then ncc under process.execPath, never via pnpm or $PATH', () => {
    execFileSyncMock.mockReset()
    const agentDir = join(REPO_ROOT, 'packages/agent')
    const vaultActionDir = join(REPO_ROOT, 'packages/vault-action')

    buildFreshDist(REPO_ROOT, '/tmp/out')

    expect(execFileSyncMock.mock.calls).toEqual([
      [
        process.execPath,
        [resolveBin('typescript', 'tsc', agentDir)],
        { cwd: agentDir, stdio: 'inherit' },
      ],
      [
        process.execPath,
        [
          resolveBin('@vercel/ncc', 'ncc', vaultActionDir),
          'build',
          'src/index.ts',
          '-o',
          '/tmp/out',
          '--minify=false',
          '--source-map',
          '--license',
          'licenses.txt',
        ],
        { cwd: vaultActionDir, stdio: 'inherit' },
      ],
    ])
  })
})
