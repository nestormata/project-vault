import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'
import {
  EXPECTED_COPYRIGHT_LINE,
  EXPECTED_MIT_LICENSE,
  EXTENSION_API_DIR,
  findLicenseProblems,
} from './check-extension-api-license.js'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const makeFixtureRoot = useFixtureRoots('check-extension-api-license-', [EXTENSION_API_DIR])

const PACKAGE_LICENSE = `${EXTENSION_API_DIR}/LICENSE`
const ROOT_MANIFEST = 'package.json'
const PACKAGE_MANIFEST = `${EXTENSION_API_DIR}/${ROOT_MANIFEST}`

function readRepo(relativePath: string): string {
  return readFileSync(join(repositoryRoot, relativePath), 'utf8')
}

/** A fixture root holding copies of the four files the check reads, as committed. */
function makeCommittedCopy(): string {
  const root = makeFixtureRoot()
  for (const path of ['LICENSE', ROOT_MANIFEST, PACKAGE_LICENSE, PACKAGE_MANIFEST]) {
    writeFixture(root, path, readRepo(path))
  }
  return root
}

function editManifest(
  root: string,
  path: string,
  edit: (manifest: Record<string, unknown>) => void
) {
  const manifest = JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, unknown>
  edit(manifest)
  writeFixture(root, path, `${JSON.stringify(manifest, null, 2)}\n`)
}

describe('check-extension-api-license', () => {
  it('the committed repository matches the intended MIT/AGPL split', () => {
    expect(findLicenseProblems(repositoryRoot)).toEqual([])
  })

  it('accepts CRLF line endings and a missing trailing newline in the MIT text', () => {
    const root = makeCommittedCopy()
    writeFixture(root, PACKAGE_LICENSE, EXPECTED_MIT_LICENSE.trimEnd().replaceAll('\n', '\r\n'))
    expect(findLicenseProblems(root)).toEqual([])
  })

  it('flags the package LICENSE when it is still the root AGPL text', () => {
    const root = makeCommittedCopy()
    writeFixture(root, PACKAGE_LICENSE, readRepo('LICENSE'))
    expect(findLicenseProblems(root)).toEqual([expect.stringContaining(PACKAGE_LICENSE)])
  })

  it('flags an MIT LICENSE with a different copyright line', () => {
    const root = makeCommittedCopy()
    writeFixture(
      root,
      PACKAGE_LICENSE,
      EXPECTED_MIT_LICENSE.replace(EXPECTED_COPYRIGHT_LINE, 'Copyright (c) 2026 Someone Else')
    )
    expect(findLicenseProblems(root)).toEqual([expect.stringContaining(EXPECTED_COPYRIGHT_LINE)])
  })

  it('flags an MIT LICENSE whose permission text was altered', () => {
    const root = makeCommittedCopy()
    writeFixture(root, PACKAGE_LICENSE, EXPECTED_MIT_LICENSE.replace('free of charge', 'for a fee'))
    expect(findLicenseProblems(root)).toEqual([expect.stringContaining(PACKAGE_LICENSE)])
  })

  it('flags a package manifest that does not declare MIT', () => {
    const root = makeCommittedCopy()
    editManifest(root, PACKAGE_MANIFEST, (manifest) => {
      manifest.license = 'AGPL-3.0-or-later'
    })
    expect(findLicenseProblems(root)).toEqual([
      `${PACKAGE_MANIFEST}: "license" must be "MIT", found "AGPL-3.0-or-later"`,
    ])
  })

  it('flags a package manifest whose files list drops LICENSE', () => {
    const root = makeCommittedCopy()
    editManifest(root, PACKAGE_MANIFEST, (manifest) => {
      manifest.files = ['dist']
    })
    expect(findLicenseProblems(root)).toEqual([expect.stringContaining('"files" must include')])
  })

  it('flags a root LICENSE that is no longer the AGPL text', () => {
    const root = makeCommittedCopy()
    writeFixture(root, 'LICENSE', EXPECTED_MIT_LICENSE)
    expect(findLicenseProblems(root)).toEqual([
      expect.stringContaining('LICENSE: must remain the GNU AGPL version 3 text'),
    ])
  })

  it('flags a root manifest that no longer declares AGPL-3.0-or-later', () => {
    const root = makeCommittedCopy()
    editManifest(root, ROOT_MANIFEST, (manifest) => {
      manifest.license = 'MIT'
    })
    expect(findLicenseProblems(root)).toEqual([
      'package.json: "license" must be "AGPL-3.0-or-later", found "MIT"',
    ])
  })

  it('reports missing and unparseable files instead of throwing', () => {
    const root = makeFixtureRoot()
    writeFixture(root, ROOT_MANIFEST, '{ not json')
    expect(findLicenseProblems(root)).toEqual([
      `${PACKAGE_LICENSE}: missing`,
      `${PACKAGE_MANIFEST}: missing`,
      'LICENSE: missing',
      'package.json: not valid JSON',
    ])
  })
})
