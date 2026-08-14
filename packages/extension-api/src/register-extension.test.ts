import { describe, expect, it, vi } from 'vitest'
import { ExtensionRegistrationError } from './errors.js'
import type { ExtensionRegistrationErrorReason } from './errors.js'
import { EXTENSION_API_VERSION, HOST_SUPPORTED_EXTENSION_API_RANGE } from './manifest.js'
import type { ExtensionManifest } from './manifest.js'
import { isExtensionApiVersionSupported, registerExtension } from './register-extension.js'
import type { ExtensionHooks } from './register-extension.js'

const VALID_NAME = 'com.acme.sso-extension'
const INCOMPATIBLE_API_VERSION = '2.0.0'
const INCOMPATIBLE_VERSION_REASON: ExtensionRegistrationErrorReason = 'incompatible-version'
const INVALID_NAME_REASON: ExtensionRegistrationErrorReason = 'invalid-name'

function manifest(overrides: Partial<ExtensionManifest> = {}): ExtensionManifest {
  return {
    name: VALID_NAME,
    apiVersion: EXTENSION_API_VERSION,
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

  it('accepts the exact host version through the host-owned predicate', () => {
    expect(isExtensionApiVersionSupported(EXTENSION_API_VERSION)).toBe(true)
  })
})

describe('registerExtension — AC5 (incompatible manifest)', () => {
  it('throws ExtensionRegistrationError with reason "incompatible-version" and never calls hooksFactory', () => {
    expectRejection({ apiVersion: INCOMPATIBLE_API_VERSION }, INCOMPATIBLE_VERSION_REASON)
  })

  it('rejects a valid version outside the host-owned range', () => {
    expect(isExtensionApiVersionSupported(INCOMPATIBLE_API_VERSION)).toBe(false)
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
    // The version is deliberately irrelevant because the name gate must fire first.
    expectRejection(
      { name: 'not-reverse-dns', apiVersion: INCOMPATIBLE_API_VERSION },
      INVALID_NAME_REASON
    )
  })

  it('reports the shape failure before the range failure for a valid name', () => {
    const hooksFactory = makeHooksFactory()
    let caught: unknown
    try {
      registerExtension(manifest({ apiVersion: '^2.0.0' }), hooksFactory)
    } catch (error) {
      caught = error
    }
    expect((caught as ExtensionRegistrationError).reason).toBe(INCOMPATIBLE_VERSION_REASON)
    expect((caught as ExtensionRegistrationError).message).toContain(
      'not a concrete semver version'
    )
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

describe('registerExtension — concrete canonical version gate', () => {
  it.each(['*', '', 'x', '>=1', '>=1.0.0', '>0.0.1', '^1.0.0', '~1.0.0'])(
    'rejects bypass range %j',
    (apiVersion) => {
      expectRejection({ apiVersion }, INCOMPATIBLE_VERSION_REASON)
    }
  )

  it.each(['v1.0.0', ' 1.0.0 ', '1.0.0+' + 'A'.repeat(200), 'banana', 1, undefined])(
    'rejects non-canonical declaration %j with the shape message',
    (apiVersion) => {
      const hooksFactory = makeHooksFactory()
      let caught: unknown
      try {
        registerExtension(manifest({ apiVersion: apiVersion as string }), hooksFactory)
      } catch (error) {
        caught = error
      }
      expect((caught as ExtensionRegistrationError).message).toContain(
        'not a concrete semver version'
      )
      expect((caught as ExtensionRegistrationError).message.length).toBeLessThan(320)
      expect(hooksFactory).not.toHaveBeenCalled()
    }
  )

  it.each([
    '1.2.0',
    '1.4.0',
    '0.9.0',
    '2.0.0',
    '2.0.0-beta.1',
    '1.1.0-beta.1',
    '1.3.0-beta.1',
    '2.3.1',
  ])('rejects canonical version outside %s', (apiVersion) => {
    const hooksFactory = makeHooksFactory()
    let caught: unknown
    try {
      registerExtension(manifest({ apiVersion }), hooksFactory)
    } catch (error) {
      caught = error
    }
    expect((caught as ExtensionRegistrationError).message).toContain(
      HOST_SUPPORTED_EXTENSION_API_RANGE
    )
    expect(hooksFactory).not.toHaveBeenCalled()
  })

  it('reads apiVersion once and records the validated value', () => {
    let reads = 0
    const getterManifest = { ...manifest() }
    Object.defineProperty(getterManifest, 'apiVersion', {
      get: () => {
        reads += 1
        return reads === 1 ? EXTENSION_API_VERSION : '*'
      },
      enumerable: true,
    })

    const result = registerExtension(getterManifest, makeHooksFactory())

    expect(reads).toBe(1)
    expect(result.manifest.apiVersion).toBe(EXTENSION_API_VERSION)
  })

  it('allows only the above-host same-major rollback escape', () => {
    expect(() => registerExtension(manifest({ apiVersion: '1.2.0' }), makeHooksFactory())).toThrow()
    expect(() =>
      registerExtension(manifest({ apiVersion: '1.2.0' }), makeHooksFactory(), {
        allowApiVersionAboveHost: true,
      })
    ).not.toThrow()
    expect(() =>
      registerExtension(manifest({ apiVersion: '*' }), makeHooksFactory(), {
        allowApiVersionAboveHost: true,
      })
    ).toThrow(/not a concrete semver version/)
    expect(() =>
      registerExtension(manifest({ apiVersion: '2.0.0' }), makeHooksFactory(), {
        allowApiVersionAboveHost: true,
      })
    ).toThrow(/outside this host's supported range/)
  })
})
