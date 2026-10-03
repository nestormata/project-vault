import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'
import {
  ALLOWED_PRODUCTION_LICENSES,
  findBoundaryProblems,
  findLicenseClosureProblems,
  licenseIsAllowed,
} from './check-composition-kit-boundary.js'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const makeRoot = useFixtureRoots('check-composition-kit-boundary-', [
  'packages/composition-kit/src',
  'apps/web/src',
])

const KIT_SRC = 'packages/composition-kit/src'
const BIG_WEB_FILE = `export const answer = 42\n${'// padding to be a meaningful file\n'.repeat(4)}`

describe('MIT boundary guard (Story 68.3 AC-1)', () => {
  it('the committed kit imports nothing from apps/web or a workspace package', () => {
    expect(findBoundaryProblems(repositoryRoot)).toEqual([])
  })

  it.each([
    ['a relative import into apps/web', "import x from '../../../apps/web/src/lib/foo'"],
    ['a web-host import', "import x from '@project-vault/web-host/manifest'"],
    ['a shared import', "import { y } from '@project-vault/shared'"],
    ['a dynamic workspace import', "const m = await import('@project-vault/extension-api')"],
    ['an export-from workspace import', "export * from '@project-vault/db'"],
  ])('names the file and the import for %s', (_label, line) => {
    const root = makeRoot()
    writeFixture(root, `${KIT_SRC}/leak.ts`, `${line}\n`)
    const problems = findBoundaryProblems(root)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(`${KIT_SRC}/leak.ts`)
  })

  it('lets the kit import its own package name, relative files and node builtins', () => {
    const root = makeRoot()
    writeFixture(
      root,
      `${KIT_SRC}/ok.ts`,
      "import a from './a.js'\nimport { readFileSync } from 'node:fs'\nimport self from '@project-vault/composition-kit'\n"
    )
    expect(findBoundaryProblems(root)).toEqual([])
  })

  it('flags a byte copy of an apps/web file', () => {
    const root = makeRoot()
    writeFixture(root, 'apps/web/src/lib/util.ts', BIG_WEB_FILE)
    writeFixture(root, `${KIT_SRC}/borrowed.ts`, BIG_WEB_FILE)
    const problems = findBoundaryProblems(root)
    expect(problems).toEqual([expect.stringContaining('byte copy')])
    expect(problems[0]).toContain('apps/web/src/lib/util.ts')
  })
})

describe('production licence closure (Story 68.3 AC-14)', () => {
  it('allows only permissive licences', () => {
    expect([...ALLOWED_PRODUCTION_LICENSES].sort()).toEqual(
      ['0BSD', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'BlueOak-1.0.0', 'ISC', 'MIT'].sort()
    )
    expect(licenseIsAllowed('MIT')).toBe(true)
    expect(licenseIsAllowed('(MIT OR GPL-3.0-only)')).toBe(true)
    expect(licenseIsAllowed('(MIT AND GPL-3.0-only)')).toBe(false)
    expect(licenseIsAllowed('AGPL-3.0-or-later')).toBe(false)
    expect(licenseIsAllowed('LGPL-2.1')).toBe(false)
    expect(licenseIsAllowed(undefined)).toBe(false)
  })

  it('the committed kit has no copyleft dependency', () => {
    expect(findLicenseClosureProblems(repositoryRoot)).toEqual([])
  })

  it('fails a production dependency under a copyleft licence, transitively', () => {
    const root = makeRoot()
    const kit = 'packages/composition-kit'
    writeFixture(
      root,
      `${kit}/package.json`,
      JSON.stringify({ name: 'kit', dependencies: { direct: '1.0.0' } })
    )
    writeFixture(
      root,
      `${kit}/node_modules/direct/package.json`,
      JSON.stringify({ name: 'direct', license: 'MIT', dependencies: { deep: '1.0.0' } })
    )
    writeFixture(
      root,
      `${kit}/node_modules/deep/package.json`,
      JSON.stringify({ name: 'deep', license: 'GPL-3.0-only' })
    )
    const problems = findLicenseClosureProblems(root)
    expect(problems).toEqual([expect.stringContaining('deep')])
    expect(problems[0]).toContain('GPL-3.0-only')
  })

  it('fails a production dependency that is not installed (the closure cannot be proven)', () => {
    const root = makeRoot()
    writeFixture(
      root,
      'packages/composition-kit/package.json',
      JSON.stringify({ name: 'kit', dependencies: { ghost: '1.0.0' } })
    )
    expect(findLicenseClosureProblems(root)).toEqual([expect.stringContaining('ghost')])
  })
})
