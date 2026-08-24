import { describe, expect, it, vi } from 'vitest'
import { ExtensionRegistrationError } from './errors.js'
import type { ExtensionRegistrationErrorReason } from './errors.js'
import { EXTENSION_API_VERSION, HOST_SUPPORTED_EXTENSION_API_RANGE } from './manifest.js'
import type { ExtensionManifest } from './manifest.js'
import { isExtensionApiVersionSupported, registerExtension } from './register-extension.js'
import type { ExtensionHooks } from './register-extension.js'
import type { HostServices } from './host-services.js'

const VALID_NAME = 'com.acme.sso-extension'
// Story 23.11 AC6 — the host bumped to EXTENSION_API_VERSION 3.0.0, so this fixture (an
// out-of-range version for the "generic incompatible-version" cases below) moves to 4.0.0.
const INCOMPATIBLE_API_VERSION = '4.0.0'
const INCOMPATIBLE_VERSION_REASON: ExtensionRegistrationErrorReason = 'incompatible-version'
const INVALID_NAME_REASON: ExtensionRegistrationErrorReason = 'invalid-name'
const PROJECT_LIFECYCLE_CAPABILITY = 'project-lifecycle' as const

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

  it('passes one runtime context argument and preserves an optional dbScope declaration', () => {
    let received: unknown
    const result = registerExtension(
      manifest({ dbScope: [{ table: 'credentials', operations: ['select'] }] }),
      (context) => {
        received = context
        return {}
      }
    )
    expect(received).toEqual(expect.objectContaining({ getDbHandle: expect.any(Function) }))
    expect(result.manifest.dbScope).toEqual([{ table: 'credentials', operations: ['select'] }])
  })

  it('rejects duplicate or malformed dbScope entries before invoking hooksFactory', () => {
    expectRejection(
      {
        dbScope: [
          { table: 'credentials', operations: ['select'] },
          { table: 'credentials', operations: ['insert'] },
        ],
      },
      'invalid-db-scope'
    )
    expectRejection(
      { dbScope: [{ table: 'credentials; DROP TABLE users; --', operations: ['select'] }] },
      'invalid-db-scope'
    )
  })

  it('requires the project-lifecycle hook when that capability is declared', () => {
    expect(() =>
      registerExtension(
        manifest({ capabilities: [PROJECT_LIFECYCLE_CAPABILITY] }),
        makeHooksFactory()
      )
    ).toThrow(/project-lifecycle/)

    const hooksFactory = vi.fn(() => ({
      projectLifecycle: {
        onBeforeCreateProject: async () => ({ permitted: true as const }),
      },
    }))
    expect(
      registerExtension(manifest({ capabilities: [PROJECT_LIFECYCLE_CAPABILITY] }), hooksFactory)
        .hooks.projectLifecycle
    ).toBeDefined()
  })

  it('rejects a malformed project-lifecycle hook during registration', () => {
    expect(() =>
      registerExtension(
        manifest({ capabilities: [PROJECT_LIFECYCLE_CAPABILITY] }),
        () => ({ projectLifecycle: {} }) as ExtensionHooks
      )
    ).toThrow(/project-lifecycle/)
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

describe('registerExtension — AC-4 default HostServices (no host argument supplied)', () => {
  it('a hooksFactory that calls the default host.auditEventSource.writeAuditEvent gets a rejected promise, never a silent no-op', async () => {
    let hostWriteAuditEvent: (() => Promise<unknown>) | undefined
    const hooksFactory = vi.fn((host: HostServices): ExtensionHooks => {
      hostWriteAuditEvent = () =>
        host.auditEventSource.writeAuditEvent({
          eventType: 'ext.com.acme.foo.bar',
          orgId: 'org_1',
          payload: {},
        })
      return {}
    })

    const result = registerExtension(manifest(), hooksFactory)
    expect(result.hooks).toEqual({})
    await expect(hostWriteAuditEvent?.()).rejects.toThrow(/without a real HostServices/)
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

  it.each(['3.3.0', '0.9.0', '4.0.0', '4.0.0-beta.1', '1.1.0-beta.1', '1.3.0-beta.1', '4.3.1'])(
    'rejects canonical version outside %s',
    (apiVersion) => {
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
    }
  )

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
    // Story 25.4 AC4/Task 4 — host EXTENSION_API_VERSION is now 3.2.0 (additive-minor bump);
    // '3.3.0' is the above-host, same-major escape-eligible version, and '4.0.0' is a different
    // major (never escape-eligible).
    expect(() => registerExtension(manifest({ apiVersion: '3.3.0' }), makeHooksFactory())).toThrow()
    expect(() =>
      registerExtension(manifest({ apiVersion: '3.3.0' }), makeHooksFactory(), {
        allowApiVersionAboveHost: true,
      })
    ).not.toThrow()
    expect(() =>
      registerExtension(manifest({ apiVersion: '*' }), makeHooksFactory(), {
        allowApiVersionAboveHost: true,
      })
    ).toThrow(/not a concrete semver version/)
    expect(() =>
      registerExtension(manifest({ apiVersion: '4.0.0' }), makeHooksFactory(), {
        allowApiVersionAboveHost: true,
      })
    ).toThrow(/outside this host's supported range/)
  })
})

/**
 * Story 23.2 AC-2 — `replacesNativeLogin` manifest-field validation. All rejections use the
 * `'invalid-manifest-field'` reason (findings F-H5/N16) and must be reached unconditionally,
 * never gated behind or ordered after the apiVersion check (the `apiVersion: '*'` cases below).
 */
const INVALID_MANIFEST_FIELD = 'invalid-manifest-field'

describe('registerExtension — AC2 (replacesNativeLogin)', () => {
  const AUTH_STRATEGY_HOOKS: ExtensionHooks = { authStrategy: { onAuthenticate: vi.fn() } as never }

  function authStrategyHooksFactory() {
    return vi.fn(() => AUTH_STRATEGY_HOOKS)
  }

  it('omitted: parses fine, native login stays enabled (byte-identical to today)', () => {
    const hooksFactory = makeHooksFactory()
    const result = registerExtension(manifest(), hooksFactory)
    expect(result.manifest.replacesNativeLogin).toBeUndefined()
    expect(hooksFactory).toHaveBeenCalledTimes(1)
  })

  it('explicit false: treated exactly like omitted', () => {
    const hooksFactory = makeHooksFactory()
    const result = registerExtension(manifest({ replacesNativeLogin: false }), hooksFactory)
    expect(result.manifest.replacesNativeLogin).toBe(false)
    expect(hooksFactory).toHaveBeenCalledTimes(1)
  })

  it('true, with auth-provider capability and an authStrategy hook: accepted', () => {
    const hooksFactory = authStrategyHooksFactory()
    const result = registerExtension(manifest({ replacesNativeLogin: true }), hooksFactory)
    expect(result.manifest.replacesNativeLogin).toBe(true)
    expect(hooksFactory).toHaveBeenCalledTimes(1)
  })

  it.each(['true', 1, null, {}, []])(
    'rejects non-boolean replacesNativeLogin %j as invalid-manifest-field',
    (value) => {
      expectRejection({ replacesNativeLogin: value as unknown as boolean }, INVALID_MANIFEST_FIELD)
    }
  )

  it('rejects true without an authStrategy hook (hooksFactory returns {}) — the lockout-prevention case', () => {
    const hooksFactory = makeHooksFactory()
    let caught: unknown
    try {
      registerExtension(manifest({ replacesNativeLogin: true }), hooksFactory)
    } catch (error) {
      caught = error
    }
    expect((caught as ExtensionRegistrationError).reason).toBe(INVALID_MANIFEST_FIELD)
  })

  it('rejects true without auth-provider in capabilities[]', () => {
    const hooksFactory = authStrategyHooksFactory()
    let caught: unknown
    try {
      registerExtension(
        manifest({ replacesNativeLogin: true, capabilities: ['ui-panel'] }),
        hooksFactory
      )
    } catch (error) {
      caught = error
    }
    expect((caught as ExtensionRegistrationError).reason).toBe(INVALID_MANIFEST_FIELD)
  })

  it('is enforced unconditionally, not gated behind the apiVersion wildcard', () => {
    expectRejection(
      { apiVersion: '*', replacesNativeLogin: 'yes' as unknown as boolean },
      INVALID_MANIFEST_FIELD
    )
  })

  it('warns on an unrelated unknown top-level key but loads fine', () => {
    const hooksFactory = makeHooksFactory()
    const warn = vi.fn()
    const result = registerExtension(
      { ...manifest(), someFutureField: true } as ExtensionManifest,
      hooksFactory,
      { logger: { warn } }
    )
    expect(result).toBeDefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('someFutureField'))
  })

  it.each(['replacesnativelogin', 'ReplacesNativeLogin', 'REPLACESNATIVELOGIN'])(
    'fails the load for a case-insensitive near-miss of a known field: %s',
    (key) => {
      const hooksFactory = makeHooksFactory()
      let caught: unknown
      try {
        registerExtension({ ...manifest(), [key]: true } as ExtensionManifest, hooksFactory)
      } catch (error) {
        caught = error
      }
      expect((caught as ExtensionRegistrationError).reason).toBe(INVALID_MANIFEST_FIELD)
      expect(hooksFactory).not.toHaveBeenCalled()
    }
  )

  it('warns (does not fail) on an insertion-variant misspelling', () => {
    const hooksFactory = makeHooksFactory()
    const warn = vi.fn()
    const result = registerExtension(
      { ...manifest(), replacesNativeLoginn: true } as ExtensionManifest,
      hooksFactory,
      { logger: { warn } }
    )
    expect(result).toBeDefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('replacesNativeLoginn'))
  })
})

/**
 * Story 25.2 AC1 — `uiPanelSlots?: string[]` manifest field validation. All rejections use the
 * `'invalid-manifest-field'` reason, following `validateReplacesNativeLoginShape`'s pattern
 * exactly.
 */
describe('registerExtension — AC1 (uiPanelSlots)', () => {
  const UI_PANEL_HOOKS: ExtensionHooks = {
    uiPanel: { onRenderPanel: vi.fn(async () => ({ html: '' })) },
  }

  function uiPanelHooksFactory() {
    return vi.fn(() => UI_PANEL_HOOKS)
  }

  it('happy path: a real multi-slot manifest (the CM module pack shape) registers successfully', () => {
    const hooksFactory = uiPanelHooksFactory()
    const result = registerExtension(
      manifest({
        capabilities: ['ui-panel'],
        uiPanelSlots: ['group', 'groups', 'document', 'classification', 'project-container'],
      }),
      hooksFactory
    )
    expect(result.manifest.uiPanelSlots).toEqual([
      'group',
      'groups',
      'document',
      'classification',
      'project-container',
    ])
    expect(hooksFactory).toHaveBeenCalledTimes(1)
  })

  it('omitted: parses fine, no uiPanelSlots on the returned manifest', () => {
    const hooksFactory = makeHooksFactory()
    const result = registerExtension(manifest(), hooksFactory)
    expect(result.manifest.uiPanelSlots).toBeUndefined()
  })

  it('undefined explicitly behaves identically to omitted', () => {
    const hooksFactory = makeHooksFactory()
    const result = registerExtension(manifest({ uiPanelSlots: undefined }), hooksFactory)
    expect(result.manifest.uiPanelSlots).toBeUndefined()
    expect(hooksFactory).toHaveBeenCalledTimes(1)
  })

  it('rejects an uppercase slot name (outside the allowed charset)', () => {
    expectRejection({ capabilities: ['ui-panel'], uiPanelSlots: ['Group'] }, INVALID_MANIFEST_FIELD)
  })

  it('rejects a slot name containing structural characters (path-traversal defense)', () => {
    expectRejection(
      { capabilities: ['ui-panel'], uiPanelSlots: ['../admin'] },
      INVALID_MANIFEST_FIELD
    )
  })

  it('rejects an oversized slot name (over 64 chars)', () => {
    expectRejection(
      { capabilities: ['ui-panel'], uiPanelSlots: ['a'.repeat(65)] },
      INVALID_MANIFEST_FIELD
    )
  })

  it('rejects duplicate entries within one manifest', () => {
    expectRejection(
      { capabilities: ['ui-panel'], uiPanelSlots: ['group', 'group'] },
      INVALID_MANIFEST_FIELD
    )
  })

  it('rejects an empty array (distinct from omitted)', () => {
    expectRejection({ capabilities: ['ui-panel'], uiPanelSlots: [] }, INVALID_MANIFEST_FIELD)
  })

  it('rejects uiPanelSlots declared without "ui-panel" in capabilities', () => {
    expectRejection(
      { capabilities: ['audit-event-source'], uiPanelSlots: ['group'] },
      INVALID_MANIFEST_FIELD
    )
  })

  it('rejects an array longer than the 32-entry maximum', () => {
    const tooMany = Array.from({ length: 33 }, (_, i) => `slot-${i}`)
    expectRejection({ capabilities: ['ui-panel'], uiPanelSlots: tooMany }, INVALID_MANIFEST_FIELD)
  })

  it('accepts exactly the 32-entry maximum', () => {
    const exactlyMax = Array.from({ length: 32 }, (_, i) => `slot-${i}`)
    const hooksFactory = uiPanelHooksFactory()
    expect(() =>
      registerExtension(
        manifest({ capabilities: ['ui-panel'], uiPanelSlots: exactlyMax }),
        hooksFactory
      )
    ).not.toThrow()
  })

  it('rejects a manifest declaring uiPanelSlots whose hooksFactory() has no uiPanel hook (post-hooksFactory check)', () => {
    const hooksFactory = makeHooksFactory()
    let caught: unknown
    try {
      registerExtension(
        manifest({ capabilities: ['ui-panel'], uiPanelSlots: ['group'] }),
        hooksFactory
      )
    } catch (error) {
      caught = error
    }
    expect((caught as ExtensionRegistrationError).reason).toBe(INVALID_MANIFEST_FIELD)
    expect(hooksFactory).toHaveBeenCalledTimes(1)
  })

  it('does NOT require a uiPanel hook merely for declaring the "ui-panel" capability without uiPanelSlots', () => {
    const hooksFactory = makeHooksFactory()
    expect(() =>
      registerExtension(manifest({ capabilities: ['ui-panel'] }), hooksFactory)
    ).not.toThrow()
  })

  it('warns on an unrecognized top-level key still includes uiPanelSlots in KNOWN_MANIFEST_KEYS (no spurious warning)', () => {
    const hooksFactory = uiPanelHooksFactory()
    const warn = vi.fn()
    registerExtension(
      manifest({ capabilities: ['ui-panel'], uiPanelSlots: ['group'] }),
      hooksFactory,
      { logger: { warn } }
    )
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('uiPanelSlots'))
  })
})
