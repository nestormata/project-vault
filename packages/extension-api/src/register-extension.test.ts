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
// Story 25.12 — used by the "declared without ui-panel in capabilities" rejection test in each
// of the uiPanelSlots/moduleActions/panelDataPaths describe blocks below; a shared constant
// avoids sonarjs/no-duplicate-string tripping on this literal repeated a 3rd time.
const AUDIT_EVENT_SOURCE_CAPABILITY = 'audit-event-source' as const
// Story 25.12 AC2 — the panelDataPaths describe block's own recurring example path template.
const ORG_USERS_DATA_PATH = '/api/v1/org/users'

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

  it.each(['3.11.0', '0.9.0', '4.0.0', '4.0.0-beta.1', '1.1.0-beta.1', '1.3.0-beta.1', '4.3.1'])(
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
    // Story 25.3 AC1/Task 1, Story 25.4 AC4/Task 4, Story 25.5 AC2/Task 1, Story 25.8 AC1/Task 1,
    // Story 20.8, Story 25.12 AC2/Task 2, Story 29.3 AC8/Task 1, and Story 29.4 AC6/Task 1 — host
    // EXTENSION_API_VERSION is now 3.10.0 (see manifest.ts's EXTENSION_API_VERSION doc comment
    // for why this merge moves past 3.2.0/3.3.0/3.4.0/3.6.0/3.7.0/3.8.0/3.9.0, which Story
    // 25.3/25.4/25.5/25.9/20.8/25.12/29.3 respectively already claimed on main for different
    // additive changes); '3.11.0' is the above-host, same-major escape-eligible version, and
    // '4.0.0' is a different major (never escape-eligible). Kept one minor version above whatever
    // EXTENSION_API_VERSION currently is — see loader.test.ts's identical comment.
    expect(() =>
      registerExtension(manifest({ apiVersion: '3.11.0' }), makeHooksFactory())
    ).toThrow()
    expect(() =>
      registerExtension(manifest({ apiVersion: '3.11.0' }), makeHooksFactory(), {
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
      { capabilities: [AUDIT_EVENT_SOURCE_CAPABILITY], uiPanelSlots: ['group'] },
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

/**
 * Story 25.5 AC2 — `moduleActions?: string[]` manifest field validation. Mirrors the
 * `uiPanelSlots` describe block above exactly (separate namespace, identical shape). All
 * rejections use the `'invalid-manifest-field'` reason.
 */
const ADD_MEMBER_ACTION = 'add-member'

describe('registerExtension — AC2 (moduleActions)', () => {
  const MODULE_ACTION_HOOKS: ExtensionHooks = {
    moduleAction: { onAction: vi.fn(async () => ({ outcome: 'ok' as const })) },
  }

  function moduleActionHooksFactory() {
    return vi.fn(() => MODULE_ACTION_HOOKS)
  }

  it('happy path: a real multi-action manifest (the CM access-group module pack shape) registers successfully', () => {
    const hooksFactory = moduleActionHooksFactory()
    const result = registerExtension(
      manifest({
        capabilities: ['ui-panel'],
        moduleActions: [
          'create-group',
          'rename-group',
          ADD_MEMBER_ACTION,
          'remove-member',
          'toggle-group',
          'classify-document',
        ],
      }),
      hooksFactory
    )
    expect(result.manifest.moduleActions).toEqual([
      'create-group',
      'rename-group',
      ADD_MEMBER_ACTION,
      'remove-member',
      'toggle-group',
      'classify-document',
    ])
    expect(hooksFactory).toHaveBeenCalledTimes(1)
  })

  it('omitted: parses fine, no moduleActions on the returned manifest', () => {
    const hooksFactory = makeHooksFactory()
    const result = registerExtension(manifest(), hooksFactory)
    expect(result.manifest.moduleActions).toBeUndefined()
  })

  it('undefined explicitly behaves identically to omitted', () => {
    const hooksFactory = makeHooksFactory()
    const result = registerExtension(manifest({ moduleActions: undefined }), hooksFactory)
    expect(result.manifest.moduleActions).toBeUndefined()
    expect(hooksFactory).toHaveBeenCalledTimes(1)
  })

  it('rejects an uppercase action name (outside the allowed charset)', () => {
    expectRejection(
      { capabilities: ['ui-panel'], moduleActions: ['Add-Member'] },
      INVALID_MANIFEST_FIELD
    )
  })

  it('rejects an action name containing structural characters (path-traversal defense)', () => {
    expectRejection(
      { capabilities: ['ui-panel'], moduleActions: ['../admin'] },
      INVALID_MANIFEST_FIELD
    )
  })

  it('rejects an oversized action name (over 64 chars)', () => {
    expectRejection(
      { capabilities: ['ui-panel'], moduleActions: ['a'.repeat(65)] },
      INVALID_MANIFEST_FIELD
    )
  })

  it('rejects duplicate entries within one manifest', () => {
    expectRejection(
      { capabilities: ['ui-panel'], moduleActions: [ADD_MEMBER_ACTION, ADD_MEMBER_ACTION] },
      INVALID_MANIFEST_FIELD
    )
  })

  it('rejects an empty array (distinct from omitted)', () => {
    expectRejection({ capabilities: ['ui-panel'], moduleActions: [] }, INVALID_MANIFEST_FIELD)
  })

  it('rejects moduleActions declared without "ui-panel" in capabilities', () => {
    expectRejection(
      { capabilities: [AUDIT_EVENT_SOURCE_CAPABILITY], moduleActions: [ADD_MEMBER_ACTION] },
      INVALID_MANIFEST_FIELD
    )
  })

  it('rejects an array longer than the 32-entry maximum', () => {
    const tooMany = Array.from({ length: 33 }, (_, i) => `action-${i}`)
    expectRejection({ capabilities: ['ui-panel'], moduleActions: tooMany }, INVALID_MANIFEST_FIELD)
  })

  it('accepts exactly the 32-entry maximum', () => {
    const exactlyMax = Array.from({ length: 32 }, (_, i) => `action-${i}`)
    const hooksFactory = moduleActionHooksFactory()
    expect(() =>
      registerExtension(
        manifest({ capabilities: ['ui-panel'], moduleActions: exactlyMax }),
        hooksFactory
      )
    ).not.toThrow()
  })

  it('rejects a manifest declaring moduleActions whose hooksFactory() has no moduleAction hook (post-hooksFactory check)', () => {
    const hooksFactory = makeHooksFactory()
    let caught: unknown
    try {
      registerExtension(
        manifest({ capabilities: ['ui-panel'], moduleActions: [ADD_MEMBER_ACTION] }),
        hooksFactory
      )
    } catch (error) {
      caught = error
    }
    expect((caught as ExtensionRegistrationError).reason).toBe(INVALID_MANIFEST_FIELD)
    expect(hooksFactory).toHaveBeenCalledTimes(1)
  })

  it('does NOT require a moduleAction hook merely for declaring the "ui-panel" capability without moduleActions', () => {
    const hooksFactory = makeHooksFactory()
    expect(() =>
      registerExtension(manifest({ capabilities: ['ui-panel'] }), hooksFactory)
    ).not.toThrow()
  })

  it('warns on an unrecognized top-level key still includes moduleActions in KNOWN_MANIFEST_KEYS (no spurious warning)', () => {
    const hooksFactory = moduleActionHooksFactory()
    const warn = vi.fn()
    registerExtension(
      manifest({ capabilities: ['ui-panel'], moduleActions: [ADD_MEMBER_ACTION] }),
      hooksFactory,
      { logger: { warn } }
    )
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('moduleActions'))
  })
})

/**
 * Story 25.12 AC2 — `panelDataPaths?: string[]` manifest field validation. Mirrors the
 * `uiPanelSlots`/`moduleActions` describe blocks above exactly (separate namespace, near-
 * identical shape), except: (1) each entry is a PATH TEMPLATE (may contain `/`-separated
 * segments and `:param` placeholders), not a bare name, and must start with the literal prefix
 * `/api/v1/`; (2) there is no post-hooksFactory callability check (AC3) — `panelDataPaths` gates
 * a client-relay allowlist, not a hook's existence, so a manifest declaring it registers
 * successfully even when `hooksFactory()` returns no hooks at all.
 */
describe('registerExtension — AC2 (panelDataPaths, Story 25.12)', () => {
  it('happy path: a real multi-path manifest (legacy pair + a new declared path) registers successfully', () => {
    const hooksFactory = makeHooksFactory()
    const result = registerExtension(
      manifest({
        capabilities: ['ui-panel'],
        panelDataPaths: ['/api/v1/projects', '/api/v1/projects/:id', ORG_USERS_DATA_PATH],
      }),
      hooksFactory
    )
    expect(result.manifest.panelDataPaths).toEqual([
      '/api/v1/projects',
      '/api/v1/projects/:id',
      ORG_USERS_DATA_PATH,
    ])
    expect(hooksFactory).toHaveBeenCalledTimes(1)
  })

  it('accepts a template containing a :param placeholder segment', () => {
    const hooksFactory = makeHooksFactory()
    expect(() =>
      registerExtension(
        manifest({ capabilities: ['ui-panel'], panelDataPaths: ['/api/v1/org/users/:id'] }),
        hooksFactory
      )
    ).not.toThrow()
  })

  it('omitted: parses fine, no panelDataPaths on the returned manifest', () => {
    const hooksFactory = makeHooksFactory()
    const result = registerExtension(manifest(), hooksFactory)
    expect(result.manifest.panelDataPaths).toBeUndefined()
  })

  it('panelDataPaths: undefined explicitly behaves identically to omitted', () => {
    const hooksFactory = makeHooksFactory()
    const result = registerExtension(manifest({ panelDataPaths: undefined }), hooksFactory)
    expect(result.manifest.panelDataPaths).toBeUndefined()
    expect(hooksFactory).toHaveBeenCalledTimes(1)
  })

  it('rejects a template missing the required /api/v1/ prefix', () => {
    expectRejection(
      { capabilities: ['ui-panel'], panelDataPaths: ['org/users'] },
      INVALID_MANIFEST_FIELD
    )
  })

  it('rejects a template with an out-of-charset literal segment', () => {
    expectRejection(
      { capabilities: ['ui-panel'], panelDataPaths: ['/api/v1/Org/Users'] },
      INVALID_MANIFEST_FIELD
    )
  })

  it('rejects a template containing a path-traversal segment', () => {
    expectRejection(
      { capabilities: ['ui-panel'], panelDataPaths: ['/api/v1/../admin'] },
      INVALID_MANIFEST_FIELD
    )
  })

  it('rejects duplicate panelDataPaths entries within one manifest', () => {
    expectRejection(
      { capabilities: ['ui-panel'], panelDataPaths: [ORG_USERS_DATA_PATH, ORG_USERS_DATA_PATH] },
      INVALID_MANIFEST_FIELD
    )
  })

  it('rejects an empty panelDataPaths array (distinct from omitted)', () => {
    expectRejection({ capabilities: ['ui-panel'], panelDataPaths: [] }, INVALID_MANIFEST_FIELD)
  })

  it('rejects panelDataPaths declared without "ui-panel" in capabilities', () => {
    expectRejection(
      { capabilities: [AUDIT_EVENT_SOURCE_CAPABILITY], panelDataPaths: [ORG_USERS_DATA_PATH] },
      INVALID_MANIFEST_FIELD
    )
  })

  it('rejects a panelDataPaths array longer than the 32-entry maximum', () => {
    const tooMany = Array.from({ length: 33 }, (_, i) => `/api/v1/resource-${i}`)
    expectRejection({ capabilities: ['ui-panel'], panelDataPaths: tooMany }, INVALID_MANIFEST_FIELD)
  })

  it('accepts exactly the 32-entry panelDataPaths maximum', () => {
    const exactlyMax = Array.from({ length: 32 }, (_, i) => `/api/v1/resource-${i}`)
    const hooksFactory = makeHooksFactory()
    expect(() =>
      registerExtension(
        manifest({ capabilities: ['ui-panel'], panelDataPaths: exactlyMax }),
        hooksFactory
      )
    ).not.toThrow()
  })

  it('AC3: no post-hooksFactory callability check — registers fine even though hooksFactory() returns no hooks at all', () => {
    const hooksFactory = makeHooksFactory()
    expect(() =>
      registerExtension(
        manifest({ capabilities: ['ui-panel'], panelDataPaths: [ORG_USERS_DATA_PATH] }),
        hooksFactory
      )
    ).not.toThrow()
    expect(hooksFactory).toHaveBeenCalledTimes(1)
  })

  it('does NOT require panelDataPaths merely for declaring the "ui-panel" capability', () => {
    const hooksFactory = makeHooksFactory()
    expect(() =>
      registerExtension(manifest({ capabilities: ['ui-panel'] }), hooksFactory)
    ).not.toThrow()
  })

  it('warns on an unrecognized top-level key still includes panelDataPaths in KNOWN_MANIFEST_KEYS (no spurious warning)', () => {
    const hooksFactory = makeHooksFactory()
    const warn = vi.fn()
    registerExtension(
      manifest({ capabilities: ['ui-panel'], panelDataPaths: [ORG_USERS_DATA_PATH] }),
      hooksFactory,
      { logger: { warn } }
    )
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('panelDataPaths'))
  })
})

/**
 * Story 29.3 AC1-AC3/AC7 — `navItems?: ExtensionNavItem[]` manifest field validation. Mirrors
 * `validateUiPanelSlotsShape`'s exact structure, EXCEPT `navItems` is deliberately NOT gated
 * behind the `'ui-panel'` capability (AC1) — this describe block's own happy-path tests
 * intentionally declare only `'auth-provider'` to prove that independence, unlike every other
 * optional-array-field describe block above.
 */
describe('registerExtension — AC1-AC3/AC6/AC7 (navItems, Story 29.3)', () => {
  const TOP_ITEM = { id: 'settings-page', label: 'Extension Settings', href: '/ext/settings' }
  const CHILD_ITEM = {
    id: 'settings-child',
    label: 'Child',
    href: '/ext/settings/child',
    parentId: 'settings-page',
  }

  it('happy path: a real navItems list (with icon, no capability gate) registers successfully', () => {
    const hooksFactory = makeHooksFactory()
    const result = registerExtension(
      manifest({
        capabilities: ['auth-provider'],
        navItems: [{ ...TOP_ITEM, icon: 'puzzle-piece' }, CHILD_ITEM],
      }),
      hooksFactory
    )
    expect(result.manifest.navItems).toEqual([{ ...TOP_ITEM, icon: 'puzzle-piece' }, CHILD_ITEM])
    expect(hooksFactory).toHaveBeenCalledTimes(1)
  })

  it('omitted: parses fine, no navItems on the returned manifest', () => {
    const hooksFactory = makeHooksFactory()
    const result = registerExtension(manifest(), hooksFactory)
    expect(result.manifest.navItems).toBeUndefined()
  })

  it('navItems: undefined explicitly behaves identically to omitted', () => {
    const hooksFactory = makeHooksFactory()
    const result = registerExtension(manifest({ navItems: undefined }), hooksFactory)
    expect(result.manifest.navItems).toBeUndefined()
    expect(hooksFactory).toHaveBeenCalledTimes(1)
  })

  it('rejects an empty navItems array (distinct from omitted)', () => {
    expectRejection({ navItems: [] }, INVALID_MANIFEST_FIELD)
  })

  it('rejects a navItems array longer than the 32-entry maximum', () => {
    const tooMany = Array.from({ length: 33 }, (_, i) => ({
      id: `item-${i}`,
      label: `Item ${i}`,
      href: `/ext/item-${i}`,
    }))
    expectRejection({ navItems: tooMany }, INVALID_MANIFEST_FIELD)
  })

  it('accepts exactly the 32-entry navItems maximum', () => {
    const exactlyMax = Array.from({ length: 32 }, (_, i) => ({
      id: `item-${i}`,
      label: `Item ${i}`,
      href: `/ext/item-${i}`,
    }))
    const hooksFactory = makeHooksFactory()
    expect(() => registerExtension(manifest({ navItems: exactlyMax }), hooksFactory)).not.toThrow()
  })

  it('rejects a duplicate id within one manifest', () => {
    expectRejection(
      { navItems: [TOP_ITEM, { ...TOP_ITEM, label: 'Duplicate' }] },
      INVALID_MANIFEST_FIELD
    )
  })

  it('rejects an id with an invalid charset', () => {
    expectRejection(
      { navItems: [{ id: 'Bad_Id!', label: 'Bad', href: '/ext/bad' }] },
      INVALID_MANIFEST_FIELD
    )
  })

  it('rejects a label longer than MAX_NAV_ITEM_LABEL_LENGTH', () => {
    expectRejection(
      { navItems: [{ id: 'long-label', label: 'x'.repeat(129), href: '/ext/x' }] },
      INVALID_MANIFEST_FIELD
    )
  })

  it('rejects an empty label', () => {
    expectRejection(
      { navItems: [{ id: 'empty-label', label: '', href: '/ext/x' }] },
      INVALID_MANIFEST_FIELD
    )
  })

  it('rejects an href with a scheme prefix', () => {
    expectRejection(
      {
        navItems: [{ id: 'evil', label: 'Evil', href: 'javascript:alert(1)' as unknown as string }],
      },
      INVALID_MANIFEST_FIELD
    )
  })

  it('rejects an href with a protocol-relative // prefix', () => {
    expectRejection(
      { navItems: [{ id: 'evil', label: 'Evil', href: '//evil.example.com' }] },
      INVALID_MANIFEST_FIELD
    )
  })

  // Code-review regression test (2026-08-29): the case above (`//evil.example.com`) was
  // previously rejected only because `.` is outside NAV_ITEM_HREF_PATTERN's charset, not because
  // the pattern actually enforced "no protocol-relative prefix" — a dot-free, single-label
  // hostname bypassed it entirely. This exercises the real rule.
  it('rejects a dot-free protocol-relative // href (single-label hostname bypass)', () => {
    expectRejection(
      { navItems: [{ id: 'evil', label: 'Evil', href: '//evilhost' }] },
      INVALID_MANIFEST_FIELD
    )
  })

  it('rejects an href not starting with /', () => {
    expectRejection(
      { navItems: [{ id: 'relative', label: 'Relative', href: 'settings' }] },
      INVALID_MANIFEST_FIELD
    )
  })

  it('rejects an unrecognized icon token', () => {
    expectRejection(
      {
        navItems: [{ id: 'bad-icon', label: 'Bad Icon', href: '/ext/x', icon: 'rocket' as never }],
      },
      INVALID_MANIFEST_FIELD
    )
  })

  it('rejects a parentId referencing a non-existent id', () => {
    expectRejection(
      {
        navItems: [{ id: 'child', label: 'Child', href: '/ext/child', parentId: 'no-such-parent' }],
      },
      INVALID_MANIFEST_FIELD
    )
  })

  it('rejects a parentId referencing itself', () => {
    expectRejection(
      { navItems: [{ id: 'self', label: 'Self', href: '/ext/self', parentId: 'self' }] },
      INVALID_MANIFEST_FIELD
    )
  })

  it('rejects grandchild nesting: an item that is both a parentId target AND itself has a parentId', () => {
    expectRejection(
      {
        navItems: [
          { id: 'grandparent', label: 'Grandparent', href: '/ext/gp' },
          { id: 'parent', label: 'Parent', href: '/ext/p', parentId: 'grandparent' },
          { id: 'grandchild', label: 'Grandchild', href: '/ext/gc', parentId: 'parent' },
        ],
      },
      INVALID_MANIFEST_FIELD
    )
  })

  it('accepts exactly one level of nesting (parent + children, no grandchildren)', () => {
    const hooksFactory = makeHooksFactory()
    expect(() =>
      registerExtension(manifest({ navItems: [TOP_ITEM, CHILD_ITEM] }), hooksFactory)
    ).not.toThrow()
  })

  it('does NOT require "ui-panel" in capabilities (AC1: deliberate divergence)', () => {
    const hooksFactory = makeHooksFactory()
    expect(() =>
      registerExtension(
        manifest({ capabilities: ['notification-channel'], navItems: [TOP_ITEM] }),
        hooksFactory
      )
    ).not.toThrow()
  })

  it('warns on an unrecognized top-level key still includes navItems in KNOWN_MANIFEST_KEYS (no spurious warning)', () => {
    const hooksFactory = makeHooksFactory()
    const warn = vi.fn()
    registerExtension(manifest({ navItems: [TOP_ITEM] }), hooksFactory, { logger: { warn } })
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('navItems'))
  })
})

/**
 * Story 29.4 AC1/AC3 — `moduleDataRoutes?: ModuleDataRouteDeclaration[]` manifest field
 * validation. Mirrors `panelDataPaths`' path-template shape closely, EXCEPT: (1) entries are
 * `{ method: 'GET'; path: string }` objects, not bare strings, and the `path` does NOT require
 * the `/api/v1/` prefix (AC2 — the host itself owns the full mount point); (2) unlike
 * `panelDataPaths`, this field DOES have a post-hooksFactory callability check (AC3) — every
 * declared route must have a matching `moduleData["GET <path>"]` handler.
 */
const ORG_USERS_ROUTE = { method: 'GET', path: '/org/users' } as const

describe('registerExtension — AC1 (moduleDataRoutes, Story 29.4)', () => {
  function moduleDataHooksFactory(routes: { method: 'GET'; path: string }[]) {
    const moduleData: Record<string, () => Promise<{ body: unknown }>> = {}
    for (const route of routes) {
      moduleData[`${route.method} ${route.path}`] = vi.fn(async () => ({ body: {} }))
    }
    return vi.fn(() => ({ moduleData }) as ExtensionHooks)
  }

  it('happy path: a real multi-route manifest registers successfully', () => {
    const routes = [ORG_USERS_ROUTE, { method: 'GET', path: '/org/users/:id' } as const]
    const hooksFactory = moduleDataHooksFactory(routes)
    const result = registerExtension(
      manifest({ capabilities: ['ui-panel'], moduleDataRoutes: routes }),
      hooksFactory
    )
    expect(result.manifest.moduleDataRoutes).toEqual(routes)
    expect(hooksFactory).toHaveBeenCalledTimes(1)
  })

  it('omitted: parses fine, no moduleDataRoutes on the returned manifest', () => {
    const hooksFactory = makeHooksFactory()
    const result = registerExtension(manifest(), hooksFactory)
    expect(result.manifest.moduleDataRoutes).toBeUndefined()
  })

  it('moduleDataRoutes: undefined explicitly behaves identically to omitted', () => {
    const hooksFactory = makeHooksFactory()
    const result = registerExtension(manifest({ moduleDataRoutes: undefined }), hooksFactory)
    expect(result.manifest.moduleDataRoutes).toBeUndefined()
    expect(hooksFactory).toHaveBeenCalledTimes(1)
  })

  it('rejects an empty moduleDataRoutes array (distinct from omitted)', () => {
    expectRejection({ moduleDataRoutes: [] }, INVALID_MANIFEST_FIELD)
  })

  it('rejects a path missing its leading slash', () => {
    expectRejection(
      { moduleDataRoutes: [{ method: 'GET', path: 'org/users' }] },
      INVALID_MANIFEST_FIELD
    )
  })

  it('rejects a path containing a .. segment', () => {
    expectRejection(
      { moduleDataRoutes: [{ method: 'GET', path: '/../admin/users' }] },
      INVALID_MANIFEST_FIELD
    )
  })

  it('rejects a path containing an uppercase letter', () => {
    expectRejection(
      { moduleDataRoutes: [{ method: 'GET', path: '/Org/Users' }] },
      INVALID_MANIFEST_FIELD
    )
  })

  it('rejects a path containing a literal dot', () => {
    expectRejection(
      { moduleDataRoutes: [{ method: 'GET', path: '/org.users' }] },
      INVALID_MANIFEST_FIELD
    )
  })

  it('accepts a path with a :param placeholder segment', () => {
    const routes = [{ method: 'GET', path: '/org/users/:id' } as const]
    const hooksFactory = moduleDataHooksFactory(routes)
    expect(() =>
      registerExtension(manifest({ moduleDataRoutes: routes }), hooksFactory)
    ).not.toThrow()
  })

  it('rejects duplicate (method, path) pairs within one manifest', () => {
    expectRejection(
      { moduleDataRoutes: [ORG_USERS_ROUTE, ORG_USERS_ROUTE] },
      INVALID_MANIFEST_FIELD
    )
  })

  it('rejects a moduleDataRoutes array longer than the 32-entry maximum', () => {
    const tooMany = Array.from({ length: 33 }, (_, i) => ({
      method: 'GET' as const,
      path: `/resource-${i}`,
    }))
    expectRejection({ moduleDataRoutes: tooMany }, INVALID_MANIFEST_FIELD)
  })

  it('accepts exactly the 32-entry moduleDataRoutes maximum', () => {
    const exactlyMax = Array.from({ length: 32 }, (_, i) => ({
      method: 'GET' as const,
      path: `/resource-${i}`,
    }))
    const hooksFactory = moduleDataHooksFactory(exactlyMax)
    expect(() =>
      registerExtension(manifest({ moduleDataRoutes: exactlyMax }), hooksFactory)
    ).not.toThrow()
  })

  it('rejects a manifest declaring moduleDataRoutes whose hooksFactory() result has no moduleData map at all (post-hooksFactory check, AC3)', () => {
    const hooksFactory = makeHooksFactory()
    let caught: unknown
    try {
      registerExtension(manifest({ moduleDataRoutes: [ORG_USERS_ROUTE] }), hooksFactory)
    } catch (error) {
      caught = error
    }
    expect((caught as ExtensionRegistrationError).reason).toBe(INVALID_MANIFEST_FIELD)
    expect(hooksFactory).toHaveBeenCalledTimes(1)
  })

  it('rejects a moduleData map missing the exact "GET <path>" key (AC3)', () => {
    const hooksFactory = vi.fn(
      () => ({ moduleData: { 'GET /org/other': vi.fn() } }) as unknown as ExtensionHooks
    )
    let caught: unknown
    try {
      registerExtension(manifest({ moduleDataRoutes: [ORG_USERS_ROUTE] }), hooksFactory)
    } catch (error) {
      caught = error
    }
    expect((caught as ExtensionRegistrationError).reason).toBe(INVALID_MANIFEST_FIELD)
    expect((caught as ExtensionRegistrationError).message).toContain('GET /org/users')
  })

  it('does NOT require moduleDataRoutes merely for declaring the "ui-panel" capability', () => {
    const hooksFactory = makeHooksFactory()
    expect(() =>
      registerExtension(manifest({ capabilities: ['ui-panel'] }), hooksFactory)
    ).not.toThrow()
  })

  it('warns on an unrecognized top-level key still includes moduleDataRoutes in KNOWN_MANIFEST_KEYS (no spurious warning)', () => {
    const hooksFactory = moduleDataHooksFactory([ORG_USERS_ROUTE])
    const warn = vi.fn()
    registerExtension(manifest({ moduleDataRoutes: [ORG_USERS_ROUTE] }), hooksFactory, {
      logger: { warn },
    })
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('moduleDataRoutes'))
  })
})
