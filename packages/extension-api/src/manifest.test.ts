import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import semver from 'semver'
import {
  EXTENSION_API_VERSION,
  HOST_SUPPORTED_EXTENSION_API_RANGE,
  defineExtension,
} from './manifest.js'
import type { ExtensionCapability, ExtensionManifest } from './manifest.js'
import { isExtensionApiVersionSupported } from './register-extension.js'

const PACKAGE_JSON_PATH = fileURLToPath(new URL('../package.json', import.meta.url))
const TEST_EXTENSION_NAME = 'com.acme.sso-extension'
const TEST_CAPABILITIES: ExtensionCapability[] = ['auth-provider']

describe('EXTENSION_API_VERSION', () => {
  it('is a valid semver string (AC1)', () => {
    expect(semver.valid(EXTENSION_API_VERSION)).toBe(EXTENSION_API_VERSION)
  })

  it('derives the host-owned floor and ceiling range', () => {
    expect(HOST_SUPPORTED_EXTENSION_API_RANGE).toBe('>=2.0.0 <=2.2.0')
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
      name: TEST_EXTENSION_NAME,
      apiVersion: EXTENSION_API_VERSION,
      capabilities: TEST_CAPABILITIES,
    }

    expect(defineExtension(manifest)).toBe(manifest)
  })

  it('accepts replacesNativeLogin: true unchanged (Story 23.2 AC-2)', () => {
    const manifest: ExtensionManifest = {
      name: TEST_EXTENSION_NAME,
      apiVersion: EXTENSION_API_VERSION,
      capabilities: TEST_CAPABILITIES,
      replacesNativeLogin: true,
    }

    expect(defineExtension(manifest)).toBe(manifest)
  })

  it('is unchanged when replacesNativeLogin is omitted (Story 23.2 AC-2)', () => {
    const manifest: ExtensionManifest = {
      name: TEST_EXTENSION_NAME,
      apiVersion: EXTENSION_API_VERSION,
      capabilities: TEST_CAPABILITIES,
    }

    expect(defineExtension(manifest).replacesNativeLogin).toBeUndefined()
  })
})

describe('Story 23.3 AC-30/AC-31 — the capability-gate version bump is additive-minor, backward compatible', () => {
  it('an extension pinned to the exact previous-minor version still loads under the new ceiling (AC-31)', () => {
    // The published package has crossed a breaking major for the new runtime context contract.
    expect(isExtensionApiVersionSupported('2.0.0')).toBe(true)
  })

  it('an extension pinned above the new ceiling is rejected (unchanged, pre-existing floor/ceiling behavior)', () => {
    expect(isExtensionApiVersionSupported('9.9.9')).toBe(false)
  })

  it('a prerelease of the new version is still rejected (includePrerelease: false, unchanged — AC-31 edge case)', () => {
    expect(isExtensionApiVersionSupported(`${EXTENSION_API_VERSION}-beta.1`)).toBe(false)
  })
})

describe('Story 23.3 AC-17/AC-32 — PV-internal tunables are NOT part of the published contract', () => {
  it('no exported symbol from the package root references a timeout, in-flight cap, or audit-window value', async () => {
    const rootExports = await import('./index.js')
    const serialized = JSON.stringify(Object.keys(rootExports))
    expect(serialized).not.toMatch(/timeout/i)
    expect(serialized).not.toMatch(/inFlight/i)
    expect(serialized).not.toMatch(/dampen/i)
  })
})
