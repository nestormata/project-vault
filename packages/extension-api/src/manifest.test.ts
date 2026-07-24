import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import semver from 'semver'
import { EXTENSION_API_VERSION, defineExtension } from './manifest.js'
import type { ExtensionManifest } from './manifest.js'

const PACKAGE_JSON_PATH = fileURLToPath(new URL('../package.json', import.meta.url))

describe('EXTENSION_API_VERSION', () => {
  it('is a valid semver string (AC1)', () => {
    expect(semver.valid(EXTENSION_API_VERSION)).not.toBeNull()
  })

  it('matches the package.json version field exactly (version-skew guard invariant, AC7)', () => {
    // PACKAGE_JSON_PATH is a fixed, module-relative sibling-file path derived from
    // import.meta.url, not external input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8')) as { version: string }
    expect(EXTENSION_API_VERSION).toBe(packageJson.version)
  })
})

describe('defineExtension', () => {
  it('is a typed identity function returning the manifest unchanged (AC1)', () => {
    const manifest: ExtensionManifest = {
      name: 'com.acme.sso-extension',
      apiVersion: '^1.0.0',
      capabilities: ['auth-provider'],
    }

    expect(defineExtension(manifest)).toBe(manifest)
  })
})
