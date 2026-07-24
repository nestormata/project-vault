import { describe, expect, it, vi } from 'vitest'
import { ExtensionRegistrationError } from './errors.js'
import type { ExtensionRegistrationErrorReason } from './errors.js'
import { EXTENSION_API_VERSION } from './manifest.js'
import type { ExtensionManifest } from './manifest.js'
import { isApiVersionCompatible, registerExtension } from './register-extension.js'
import type { ExtensionHooks } from './register-extension.js'

const VALID_NAME = 'com.acme.sso-extension'
const INCOMPATIBLE_API_VERSION = '^2.0.0'
const INVALID_NAME_REASON: ExtensionRegistrationErrorReason = 'invalid-name'

function manifest(overrides: Partial<ExtensionManifest> = {}): ExtensionManifest {
  return {
    name: VALID_NAME,
    // Compatible with this story's EXTENSION_API_VERSION ("1.0.0" — see manifest.ts).
    apiVersion: '^1.0.0',
    capabilities: ['auth-provider'],
    ...overrides,
  }
}

function makeHooksFactory() {
  const hooks: ExtensionHooks = {}
  return vi.fn(() => hooks)
}

/**
 * Asserts `registerExtension(manifestOverrides, hooksFactory)` throws a typed
 * `ExtensionRegistrationError` with the given `reason` AND that `hooksFactory` was never called
 * — the two things every rejection path in AC5/AC6 must prove together (a spy/mock assertion of
 * zero calls, not just "it throws").
 */
function expectRejection(
  manifestOverrides: Partial<ExtensionManifest>,
  expectedReason: ExtensionRegistrationErrorReason
): void {
  const hooksFactory = makeHooksFactory()
  let caught: unknown
  try {
    registerExtension(manifest(manifestOverrides), hooksFactory)
  } catch (error) {
    caught = error
  }

  expect(caught).toBeInstanceOf(ExtensionRegistrationError)
  expect((caught as ExtensionRegistrationError).reason).toBe(expectedReason)
  expect(hooksFactory).not.toHaveBeenCalled()
}

describe('registerExtension — AC4 (compatible manifest)', () => {
  it('invokes hooksFactory exactly once and returns the manifest + accepted hooks when the semver range and name both pass', () => {
    const hooksFactory = makeHooksFactory()

    const result = registerExtension(manifest(), hooksFactory)

    expect(hooksFactory).toHaveBeenCalledTimes(1)
    expect(result.hooks).toBe(hooksFactory.mock.results[0]?.value)
    expect(result.manifest.name).toBe(VALID_NAME)
  })

  it("matches the story's literal AC4 example (apiVersion '^1.2.0' against core '1.3.0')", () => {
    expect(isApiVersionCompatible('1.3.0', '^1.2.0')).toBe(true)
  })
})

describe('registerExtension — AC5 (incompatible manifest)', () => {
  it('throws ExtensionRegistrationError with reason "incompatible-version" and never calls hooksFactory', () => {
    expectRejection({ apiVersion: INCOMPATIBLE_API_VERSION }, 'incompatible-version')
  })

  it("matches the story's literal AC5 example (apiVersion '^2.0.0' against core '1.3.0')", () => {
    expect(isApiVersionCompatible('1.3.0', INCOMPATIBLE_API_VERSION)).toBe(false)
  })

  it('throws synchronously (not a rejected Promise)', () => {
    const hooksFactory = makeHooksFactory()
    let threwSynchronously = false
    try {
      registerExtension(manifest({ apiVersion: INCOMPATIBLE_API_VERSION }), hooksFactory)
    } catch {
      threwSynchronously = true
    }
    expect(threwSynchronously).toBe(true)
  })
})

describe('registerExtension — AC6 (manifest name validation)', () => {
  it('accepts a valid reverse-DNS-style name', () => {
    const hooksFactory = makeHooksFactory()
    expect(() => registerExtension(manifest({ name: VALID_NAME }), hooksFactory)).not.toThrow()
    expect(hooksFactory).toHaveBeenCalledTimes(1)
  })

  it('rejects a name with no dot (invalid shape 1) and never calls hooksFactory', () => {
    expectRejection({ name: 'acmesso' }, INVALID_NAME_REASON)
  })

  it('rejects a name with an uppercase character (invalid shape 2) and never calls hooksFactory', () => {
    expectRejection({ name: 'com.Acme.sso-extension' }, INVALID_NAME_REASON)
  })
})

describe('registerExtension — validation ordering (name before semver)', () => {
  it('rejects for invalid-name even when apiVersion is also incompatible, proving name is checked first', () => {
    expectRejection({ name: 'not-reverse-dns', apiVersion: '^99.0.0' }, INVALID_NAME_REASON)
  })
})

describe('registerExtension — hooksFactory laziness', () => {
  it('never constructs hooks before both validation gates pass, even for a factory with side effects', () => {
    let constructed = false
    const hooksFactory = (): ExtensionHooks => {
      constructed = true
      return {}
    }

    expect(() =>
      registerExtension(manifest({ apiVersion: INCOMPATIBLE_API_VERSION }), hooksFactory)
    ).toThrow(ExtensionRegistrationError)
    expect(constructed).toBe(false)
  })
})

describe('isApiVersionCompatible — AC5 prerelease handling', () => {
  it('a stable manifest range does NOT satisfy a prerelease core version (explicit includePrerelease: false)', () => {
    // EXTENSION_API_VERSION could in principle be a prerelease (e.g. "1.3.0-beta.1") ahead of a
    // stable release; a manifest declaring a plain "^1.2.0" range must not silently activate
    // against unstable, in-flight core behavior. This is the deliberately chosen, documented
    // behavior (see register-extension.ts) rather than an accidental default.
    expect(isApiVersionCompatible('1.3.0-beta.1', '^1.2.0')).toBe(false)
  })

  it('a manifest range that itself opts into the same prerelease line is satisfied', () => {
    expect(isApiVersionCompatible('1.3.0-beta.1', '^1.3.0-beta.1')).toBe(true)
  })

  it('a stable core version against a stable range behaves normally', () => {
    expect(isApiVersionCompatible(EXTENSION_API_VERSION, '^1.0.0')).toBe(true)
    expect(isApiVersionCompatible(EXTENSION_API_VERSION, INCOMPATIBLE_API_VERSION)).toBe(false)
  })
})
