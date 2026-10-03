import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'
import { kitCorners } from './check-release-version-triangle.js'
import { assertVersionTriangle } from './lib/version-triangle.js'

// Story 68.3 AC-1: the composition kit's own version triangle (tag == package.json == the version
// its build embeds), the gate publish-kit runs before it uploads anything.

const KIT = 'packages/composition-kit'
const makeRoot = useFixtureRoots('release-version-triangle-', [KIT])

function kitRoot(packageVersion: string, embeddedVersion: string): string {
  const root = makeRoot()
  writeFixture(root, join(KIT, 'package.json'), JSON.stringify({ version: packageVersion }))
  writeFixture(
    root,
    join(KIT, 'src', 'version.ts'),
    `export const KIT_VERSION = '${embeddedVersion}'\n`
  )
  return root
}

describe('kitCorners', () => {
  it('reads the tag, the package version and the embedded version', async () => {
    expect(await kitCorners('0.1.0', kitRoot('0.1.0', '0.1.0'))).toEqual({
      tag: '0.1.0',
      package: '0.1.0',
      embedded: '0.1.0',
    })
  })

  it('fails the triangle when the package and the embedded version differ, naming both', async () => {
    const corners = await kitCorners('0.1.0', kitRoot('0.1.0', '0.1.1'))
    expect(() => assertVersionTriangle(corners)).toThrow(
      /"package":"0\.1\.0".*"embedded":"0\.1\.1"/
    )
  })

  it('fails the triangle when the tag is not the package version', async () => {
    const corners = await kitCorners('0.2.0', kitRoot('0.1.0', '0.1.0'))
    expect(() => assertVersionTriangle(corners)).toThrow(/version triangle mismatch/)
  })

  it('reports a missing embedded version as such', async () => {
    const root = makeRoot()
    writeFixture(root, join(KIT, 'package.json'), JSON.stringify({ version: '0.1.0' }))
    writeFixture(root, join(KIT, 'src', 'version.ts'), 'export {}\n')
    expect((await kitCorners('0.1.0', root)).embedded).toBeUndefined()
  })
})
