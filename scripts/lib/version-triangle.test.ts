import { describe, expect, it } from 'vitest'
import { releaseImageRef } from './release-image.js'
import {
  assertVersionTriangle,
  extensionApiVersion,
  readExtensionApiVersions,
} from './version-triangle.js'

describe('assertVersionTriangle', () => {
  it('returns the one shared version', () => {
    expect(assertVersionTriangle({ tag: '1.4.0', package: '1.4.0', manifest: '1.4.0' })).toBe(
      '1.4.0'
    )
  })

  it('fails naming every corner when any value differs or is missing', () => {
    expect(() => assertVersionTriangle({ package: '3.25.0', manifest: '3.24.0' })).toThrow(
      'version triangle mismatch: {"package":"3.25.0","manifest":"3.24.0"}'
    )
    expect(() => assertVersionTriangle({ tag: undefined, package: undefined })).toThrow(/mismatch/)
    expect(() => assertVersionTriangle({ tag: '' })).toThrow(/mismatch/)
  })
})

describe('extension-api version corners (Story 68.2 AC-9)', () => {
  it('reads package.json and EXTENSION_API_VERSION from the source manifest, which agree', async () => {
    const versions = await readExtensionApiVersions()
    expect(versions.package).toBe(versions.manifest)
    expect(await extensionApiVersion()).toBe(versions.package)
  })
})

describe('releaseImageRef', () => {
  it('formats the container-publish.yml tag, lowercasing the repository', () => {
    expect(releaseImageRef('NestorMata/project-vault', 'api', '1.4.0-rc.1')).toBe(
      'ghcr.io/nestormata/project-vault/api:1.4.0-rc.1'
    )
  })
})
