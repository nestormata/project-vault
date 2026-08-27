import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EXTENSION_API_VERSION, ExtensionRegistrationError } from '@project-vault/extension-api'
import type { ExtensionHooks, ExtensionManifest } from '@project-vault/extension-api'
import {
  __resetExtensionStateForTests,
  getExtensionStatus,
  getExtensionsHealthField,
  loadExtension,
  readVersionFromPackageDir,
} from './loader.js'
import type { LoadExtensionDeps } from './loader.js'

const VALID_MANIFEST: ExtensionManifest = {
  name: 'com.acme.sso-extension',
  apiVersion: EXTENSION_API_VERSION,
  capabilities: ['auth-provider'],
}

const NOOP_HOOKS: ExtensionHooks = {}
const VALID_PACKAGE_NAME = '@acme/extension'
const PACKAGE_JSON_FILENAME = 'package.json'
const BAD_PACKAGE_NAME = 'bad-package'

function noopLogger(): LoadExtensionDeps['logger'] {
  return { warn: vi.fn(), fatal: vi.fn(), error: vi.fn() }
}

function baseDeps(overrides: LoadExtensionDeps = {}): LoadExtensionDeps {
  return {
    listOrgIds: async () => [],
    auditWriter: vi.fn().mockResolvedValue(undefined),
    logger: noopLogger(),
    timeoutMs: 50,
    ...overrides,
  }
}

function validImportFn(hooksFactory: () => ExtensionHooks = () => NOOP_HOOKS) {
  return vi.fn().mockResolvedValue({ default: { manifest: VALID_MANIFEST, hooksFactory } })
}

beforeEach(() => {
  __resetExtensionStateForTests()
})

describe('loadExtension — unset env (AC-1)', () => {
  it('no-ops when packageName is undefined: state stays not_configured, no import attempted', async () => {
    const importFn = vi.fn()
    await loadExtension(undefined, baseDeps({ importFn }))

    expect(importFn).not.toHaveBeenCalled()
    expect(getExtensionStatus()).toEqual({ status: 'not_configured' })
    expect(getExtensionsHealthField()).toBe('not_configured')
  })

  it('no-ops when packageName is an empty string', async () => {
    const importFn = vi.fn()
    await loadExtension('', baseDeps({ importFn }))

    expect(importFn).not.toHaveBeenCalled()
    expect(getExtensionStatus()).toEqual({ status: 'not_configured' })
  })
})

describe('loadExtension — valid package (AC-2)', () => {
  it('imports, registers, stores hooks + manifest, and reports loaded', async () => {
    const hooksFactory = vi.fn(() => NOOP_HOOKS)
    const importFn = validImportFn(hooksFactory)
    const auditWriter = vi.fn().mockResolvedValue(undefined)

    await loadExtension(
      VALID_PACKAGE_NAME,
      baseDeps({ importFn, auditWriter, listOrgIds: async () => ['org-1'] })
    )

    expect(importFn).toHaveBeenCalledWith(VALID_PACKAGE_NAME)
    expect(hooksFactory).toHaveBeenCalledTimes(1)
    const status = getExtensionStatus()
    expect(status.status).toBe('loaded')
    if (status.status === 'loaded') {
      expect(status.manifest).toEqual(VALID_MANIFEST)
      expect(status.hooks).toBe(NOOP_HOOKS)
      expect(typeof status.loadedAt).toBe('string')
    }
    expect(getExtensionsHealthField()).toBe('loaded')
    expect(auditWriter).toHaveBeenCalledWith(
      'org-1',
      'extension.loaded',
      expect.objectContaining({
        name: VALID_MANIFEST.name,
        apiVersion: VALID_MANIFEST.apiVersion,
        capabilities: VALID_MANIFEST.capabilities,
      })
    )
  })

  it('loads a declared DB scope but withholds the handle until operator approval exists', async () => {
    let getDbHandle: (() => Promise<unknown>) | undefined
    const importFn = vi.fn().mockResolvedValue({
      default: {
        manifest: {
          ...VALID_MANIFEST,
          dbScope: [{ table: 'credentials', operations: ['select'] }],
        },
        hooksFactory: (context: { getDbHandle: () => Promise<unknown> }) => {
          getDbHandle = context.getDbHandle
          return NOOP_HOOKS
        },
      },
    })

    await loadExtension(VALID_PACKAGE_NAME, baseDeps({ importFn }))

    expect(getExtensionStatus().status).toBe('loaded')
    await expect(getDbHandle?.()).resolves.toEqual({ unavailable: 'no-approved-scope' })
  })

  // Story 23.9 Task 4 (pre-mortem finding) — an auditEventSource-only wiring assertion passing
  // is not sufficient evidence orgAuthorization was actually wired into buildHostServices()'s
  // returned object literal, not just added to the HostServices type (Story 20-7's "typed but
  // not wired" recurring gap shape). Assert the field is actually present on the object handed
  // to hooksFactory(), and that it is a real, callable function — not merely `in` on the object.
  it('Story 23.9 AC1/Task 4: buildHostServices() actually wires orgAuthorization.checkMembership alongside auditEventSource', async () => {
    let capturedHost: Record<string, unknown> | undefined
    const importFn = vi.fn().mockResolvedValue({
      default: {
        manifest: VALID_MANIFEST,
        hooksFactory: (host: Record<string, unknown>) => {
          capturedHost = host
          return NOOP_HOOKS
        },
      },
    })

    await loadExtension(VALID_PACKAGE_NAME, baseDeps({ importFn }))

    expect(getExtensionStatus().status).toBe('loaded')
    expect(capturedHost).toBeDefined()
    expect(capturedHost?.auditEventSource).toBeDefined()
    expect(capturedHost?.orgAuthorization).toBeDefined()
    const orgAuthorization = capturedHost?.orgAuthorization as {
      checkMembership?: unknown
    }
    expect(typeof orgAuthorization.checkMembership).toBe('function')
  })

  // Story 20.8 AC-1/AC-13/Task 4 — same "actually wired, not just typed" precedent as the
  // orgAuthorization assertion above (20-7's recurring "typed but not wired" gap shape).
  it('Story 20.8 AC-1: buildHostServices() actually wires ephemeralState alongside auditEventSource/orgAuthorization', async () => {
    let capturedHost: Record<string, unknown> | undefined
    const importFn = vi.fn().mockResolvedValue({
      default: {
        manifest: VALID_MANIFEST,
        hooksFactory: (host: Record<string, unknown>) => {
          capturedHost = host
          return NOOP_HOOKS
        },
      },
    })

    await loadExtension(VALID_PACKAGE_NAME, baseDeps({ importFn }))

    expect(getExtensionStatus().status).toBe('loaded')
    expect(capturedHost).toBeDefined()
    expect(capturedHost?.auditEventSource).toBeDefined()
    expect(capturedHost?.orgAuthorization).toBeDefined()
    expect(capturedHost?.ephemeralState).toBeDefined()
    const ephemeralState = capturedHost?.ephemeralState as {
      get?: unknown
      set?: unknown
      delete?: unknown
      compareAndSwap?: unknown
      compareAndDelete?: unknown
    }
    expect(typeof ephemeralState.get).toBe('function')
    expect(typeof ephemeralState.set).toBe('function')
    expect(typeof ephemeralState.delete).toBe('function')
    expect(typeof ephemeralState.compareAndSwap).toBe('function')
    expect(typeof ephemeralState.compareAndDelete).toBe('function')
  })
})

describe('loadExtension — failure reasons (AC-3a/3b/3c)', () => {
  it('3a: import_error — import() rejects', async () => {
    const importFn = vi.fn().mockRejectedValue(new Error('Cannot find package'))
    const auditWriter = vi.fn().mockResolvedValue(undefined)

    await loadExtension(
      'missing-package',
      baseDeps({ importFn, auditWriter, listOrgIds: async () => ['org-1'] })
    )

    expect(getExtensionStatus()).toEqual({ status: 'load_failed', reason: 'import_error' })
    expect(getExtensionsHealthField()).toBe('load_failed')
    expect(auditWriter).toHaveBeenCalledWith('org-1', 'extension.load_failed', {
      reason: 'import_error',
    })
  })

  it('3b: manifest_invalid — registerExtension throws invalid-name', async () => {
    const hooksFactory = vi.fn(() => NOOP_HOOKS)
    const importFn = vi.fn().mockImplementation(async () => {
      throw new ExtensionRegistrationError('invalid-name', 'bad name')
    })

    await loadExtension('bad-name-package', baseDeps({ importFn }))

    expect(getExtensionStatus()).toEqual({ status: 'load_failed', reason: 'manifest_invalid' })
    expect(hooksFactory).not.toHaveBeenCalled()
  })

  it('3c: capability_mismatch — registerExtension throws incompatible-version', async () => {
    const importFn = vi.fn().mockImplementation(async () => {
      throw new ExtensionRegistrationError('incompatible-version', 'bad version')
    })

    await loadExtension('incompatible-package', baseDeps({ importFn }))

    expect(getExtensionStatus()).toEqual({ status: 'load_failed', reason: 'capability_mismatch' })
  })

  it('Story 23.2 AC-2: manifest_invalid — registerExtension throws invalid-manifest-field', async () => {
    const importFn = vi.fn().mockImplementation(async () => {
      throw new ExtensionRegistrationError('invalid-manifest-field', 'bad replacesNativeLogin')
    })

    await loadExtension('bad-field-package', baseDeps({ importFn }))

    expect(getExtensionStatus()).toEqual({ status: 'load_failed', reason: 'manifest_invalid' })
  })

  it('Story 23.2 regression: incompatible-version still maps to capability_mismatch (not manifest_invalid)', async () => {
    const importFn = vi.fn().mockImplementation(async () => {
      throw new ExtensionRegistrationError('incompatible-version', 'still bad version')
    })

    await loadExtension('still-incompatible-package', baseDeps({ importFn }))

    expect(getExtensionStatus()).toEqual({ status: 'load_failed', reason: 'capability_mismatch' })
  })

  it('maps malformed apiVersion to capability_mismatch and keeps its message out of audit payloads', async () => {
    const auditWriter = vi.fn().mockResolvedValue(undefined)
    const logger = noopLogger()
    const importFn = vi.fn().mockResolvedValue({
      default: {
        manifest: { ...VALID_MANIFEST, apiVersion: 'banana' },
        hooksFactory: () => NOOP_HOOKS,
      },
    })

    await loadExtension(
      'malformed-package',
      baseDeps({ importFn, auditWriter, listOrgIds: async () => ['org-1'], logger })
    )

    expect(getExtensionStatus()).toEqual({ status: 'load_failed', reason: 'capability_mismatch' })
    expect(logger?.fatal).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'capability_mismatch',
        message: expect.stringContaining('not a concrete semver version'),
      }),
      expect.any(String)
    )
    expect(auditWriter).toHaveBeenCalledWith('org-1', 'extension.load_failed', {
      reason: 'capability_mismatch',
    })
  })

  it('3d: hooksFactory crash after negotiation passed maps to import_error, never escapes', async () => {
    const importFn = vi.fn().mockResolvedValue({
      default: {
        manifest: VALID_MANIFEST,
        hooksFactory: () => {
          throw new Error('boom inside hooksFactory')
        },
      },
    })

    await expect(loadExtension('crashy-package', baseDeps({ importFn }))).resolves.toBeUndefined()
    expect(getExtensionStatus()).toEqual({ status: 'load_failed', reason: 'import_error' })
  })

  it('3e: a hang inside import()/hooksFactory times out and maps to import_error, without unhandled rejection', async () => {
    let rejectLate: (err: Error) => void = () => undefined
    const importFn = vi.fn().mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectLate = reject
        })
    )

    await loadExtension('hanging-package', baseDeps({ importFn, timeoutMs: 10 }))

    expect(getExtensionStatus()).toEqual({ status: 'load_failed', reason: 'import_error' })

    // The losing promise rejects AFTER the timeout already resolved loadExtension(). This must
    // not produce an unhandled rejection, and must not mutate state (still load_failed).
    const unhandled = vi.fn()
    process.once('unhandledRejection', unhandled)
    rejectLate(new Error('late failure after timeout'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(unhandled).not.toHaveBeenCalled()
    expect(getExtensionStatus()).toEqual({ status: 'load_failed', reason: 'import_error' })
  })

  it('3e (late resolution): a late-resolving hooksFactory after timeout is discarded, not applied', async () => {
    let resolveLate: (value: {
      default: { manifest: ExtensionManifest; hooksFactory: () => ExtensionHooks }
    }) => void = () => undefined
    const importFn = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLate = resolve
        })
    )

    await loadExtension('slow-package', baseDeps({ importFn, timeoutMs: 10 }))
    expect(getExtensionStatus()).toEqual({ status: 'load_failed', reason: 'import_error' })

    resolveLate({ default: { manifest: VALID_MANIFEST, hooksFactory: () => NOOP_HOOKS } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    // State must remain the already-finalized load_failed outcome, not be overwritten to loaded.
    expect(getExtensionStatus()).toEqual({ status: 'load_failed', reason: 'import_error' })
  })
})

describe('loadExtension — audit fanout failure isolation (judgment call #4)', () => {
  it('continues writing remaining orgs when one org audit write throws, load outcome unaffected', async () => {
    const importFn = validImportFn()
    const auditWriter = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error('transient DB blip')
      })
      .mockImplementationOnce(async () => undefined)

    await expect(
      loadExtension(
        VALID_PACKAGE_NAME,
        baseDeps({ importFn, auditWriter, listOrgIds: async () => ['org-1', 'org-2'] })
      )
    ).resolves.toBeUndefined()

    expect(auditWriter).toHaveBeenCalledTimes(2)
    expect(getExtensionStatus().status).toBe('loaded')
  })

  it('does not crash loadExtension if listOrgIds itself throws', async () => {
    const importFn = validImportFn()
    const listOrgIds = vi.fn().mockRejectedValue(new Error('db unreachable'))

    await expect(
      loadExtension(VALID_PACKAGE_NAME, baseDeps({ importFn, listOrgIds }))
    ).resolves.toBeUndefined()
    expect(getExtensionStatus().status).toBe('loaded')
  })
})

describe('loadExtension — idempotency / double-invocation guard (judgment call #5)', () => {
  it('a second call no-ops and does not re-invoke hooksFactory or overwrite state', async () => {
    const hooksFactory = vi.fn(() => NOOP_HOOKS)
    const importFn = validImportFn(hooksFactory)
    const logger = noopLogger()

    await loadExtension(VALID_PACKAGE_NAME, baseDeps({ importFn, logger }))
    expect(getExtensionStatus().status).toBe('loaded')

    await loadExtension(VALID_PACKAGE_NAME, baseDeps({ importFn, logger }))

    expect(importFn).toHaveBeenCalledTimes(1)
    expect(hooksFactory).toHaveBeenCalledTimes(1)
    expect(logger?.warn).toHaveBeenCalled()
  })

  it('a second call after a load_failed outcome also no-ops', async () => {
    const importFn = vi.fn().mockRejectedValue(new Error('nope'))
    const logger = noopLogger()

    await loadExtension(BAD_PACKAGE_NAME, baseDeps({ importFn, logger }))
    expect(getExtensionStatus().status).toBe('load_failed')

    await loadExtension(BAD_PACKAGE_NAME, baseDeps({ importFn, logger }))

    expect(importFn).toHaveBeenCalledTimes(1)
    expect(logger?.warn).toHaveBeenCalled()
  })
})

describe('loadExtension — fatal-equivalent failure logging (Task 4)', () => {
  it('logs at fatal severity with only eventType/reason — never err/stack/message', async () => {
    const importFn = vi.fn().mockRejectedValue(new Error('/secret/internal/path leaked here'))
    const fatal = vi.fn()
    const logger = { warn: vi.fn(), fatal, error: vi.fn() }

    await loadExtension(BAD_PACKAGE_NAME, baseDeps({ importFn, logger }))

    expect(fatal).toHaveBeenCalledTimes(1)
    const [payload] = fatal.mock.calls[0] as [Record<string, unknown>, string]
    expect(payload['reason']).toBe('import_error')
    expect(payload).not.toHaveProperty('err')
    expect(payload).not.toHaveProperty('stack')
    expect(payload).not.toHaveProperty('message')
    expect(JSON.stringify(payload)).not.toContain('/secret/internal/path')
  })

  it('logs the bounded registration message for both shape and range failures', async () => {
    const logger = noopLogger()
    const importFn = vi.fn().mockResolvedValue({
      default: {
        manifest: { ...VALID_MANIFEST, apiVersion: '^1.0.0' },
        hooksFactory: () => NOOP_HOOKS,
      },
    })

    await loadExtension('range-package', baseDeps({ importFn, logger }))

    expect(logger?.fatal).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'capability_mismatch',
        message: expect.stringContaining('not a concrete semver version'),
      }),
      expect.any(String)
    )
  })

  it('warns on every load using the explicit above-host rollback escape', async () => {
    const logger = noopLogger()
    // Story 25.3 AC1/Task 1, Story 25.4 AC4/Task 4, Story 25.5 AC2/Task 1, Story 25.8 AC1/Task 1,
    // and Story 20.8 — host EXTENSION_API_VERSION is now 3.7.0 (see manifest.ts's
    // EXTENSION_API_VERSION doc comment for why this merge moves past 3.2.0/3.3.0/3.4.0/3.6.0,
    // which Story 25.3/25.4/25.5/25.9 respectively already claimed on main for different
    // additive changes); '3.8.0' is the above-host, same-major escape-eligible version. Kept one
    // minor version above whatever EXTENSION_API_VERSION currently is — a future bump must move
    // this value forward again the same way this story just did, or this test silently stops
    // exercising the above-host path once EXTENSION_API_VERSION catches up to a stale
    // hardcoded value.
    const aboveHostApiVersion = '3.8.0'
    const importFn = vi.fn().mockResolvedValue({
      default: {
        manifest: { ...VALID_MANIFEST, apiVersion: aboveHostApiVersion },
        hooksFactory: () => NOOP_HOOKS,
      },
    })

    await loadExtension(
      'rollback-package',
      baseDeps({ importFn, logger, allowApiVersionAboveHost: true })
    )

    expect(getExtensionStatus().status).toBe('loaded')
    expect(logger?.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        declaredApiVersion: aboveHostApiVersion,
        hostApiVersion: EXTENSION_API_VERSION,
        flag: 'VAULT_EXTENSIONS_ALLOW_API_VERSION_ABOVE_HOST',
      }),
      expect.any(String)
    )
  })
})

describe('getExtensionStatus / getExtensionsHealthField', () => {
  it('default state is not_configured', () => {
    expect(getExtensionStatus()).toEqual({ status: 'not_configured' })
    expect(getExtensionsHealthField()).toBe('not_configured')
  })
})

// Story 25.9 AC4/Task 1: the loader reads the loaded package's own `package.json` `version`
// field (distinct from `manifest.apiVersion`, the extension-API *contract* version) and threads
// it through ExtensionState. `readPackageVersion` is an injectable dep (mirrors `importFn`) so
// these tests can exercise both the real on-disk resolution (against this project's own
// workspace-symlinked fixture — Elicitation Log #1) and synthetic failure modes (Elicitation Log
// #4) without needing a real npm-installed package.
describe('loadExtension — package version read (AC4)', () => {
  it('happy path: threads a well-formed readPackageVersion() result into ExtensionState', async () => {
    const importFn = validImportFn()
    const readPackageVersion = vi.fn().mockReturnValue('2.4.1')

    await loadExtension(VALID_PACKAGE_NAME, baseDeps({ importFn, readPackageVersion }))

    expect(readPackageVersion).toHaveBeenCalledWith(VALID_PACKAGE_NAME)
    const status = getExtensionStatus()
    expect(status.status).toBe('loaded')
    if (status.status === 'loaded') {
      expect(status.packageVersion).toBe('2.4.1')
    }
  })

  it('missing/unreadable package.json: readPackageVersion() returning undefined never fails the load', async () => {
    const importFn = validImportFn()
    const readPackageVersion = vi.fn().mockReturnValue(undefined)

    await loadExtension(VALID_PACKAGE_NAME, baseDeps({ importFn, readPackageVersion }))

    const status = getExtensionStatus()
    expect(status.status).toBe('loaded')
    if (status.status === 'loaded') {
      expect(status.packageVersion).toBeUndefined()
    }
  })

  it('a rejecting readPackageVersion() implementation still resolves the load (defensive, never throws)', async () => {
    const importFn = validImportFn()
    const readPackageVersion = vi.fn().mockImplementation(() => {
      throw new Error('boom')
    })

    await expect(
      loadExtension(VALID_PACKAGE_NAME, baseDeps({ importFn, readPackageVersion }))
    ).resolves.toBeUndefined()
    expect(getExtensionStatus().status).toBe('loaded')
  })

  it('defaults to the real on-disk resolver, which never throws when given a package name that cannot resolve', async () => {
    const importFn = validImportFn()

    // No readPackageVersion override — exercises the real default implementation. A synthetic
    // package name unrelated to any real dependency must resolve to `undefined`, never throw and
    // never crash the load (Dev Notes: "this must never become a new load-failure mode").
    await loadExtension('@definitely-not-a-real-package/does-not-exist', baseDeps({ importFn }))

    const status = getExtensionStatus()
    expect(status.status).toBe('loaded')
    if (status.status === 'loaded') {
      expect(status.packageVersion).toBeUndefined()
    }
  })

  it(
    'workspace-symlinked fixture (Elicitation Log #1): the real default resolver reads this ' +
      "project's own pnpm-workspace-symlinked mock-ui-panel-extension fixture's package.json " +
      'version, following the symlink rather than assuming a flat node_modules/<pkg>/package.json layout',
    async () => {
      const importFn = validImportFn()

      await loadExtension('@project-vault/mock-ui-panel-extension', baseDeps({ importFn }))

      const status = getExtensionStatus()
      expect(status.status).toBe('loaded')
      if (status.status === 'loaded') {
        // fixtures/mock-ui-panel-extension/package.json declares "version": "0.0.1" — resolved via
        // the pnpm workspace symlink at node_modules/@project-vault/mock-ui-panel-extension, not a
        // flat install.
        expect(status.packageVersion).toBe('0.0.1')
      }
    }
  )
})

// Story 25.9 AC4/Task 1, Elicitation Log #4 (Failure Mode Analysis): the walk-up-and-parse core
// of the default `readPackageVersion()` implementation, exercised directly against real
// temp-directory fixtures so the missing/malformed-package.json edge cases don't depend on
// contriving an actual resolvable npm specifier.
describe('readVersionFromPackageDir (AC4 — pure walk-up/parse/validate helper)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pv-loader-pkgver-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('happy path: reads a well-formed string version field', () => {
    writeFileSync(join(dir, PACKAGE_JSON_FILENAME), JSON.stringify({ name: 'x', version: '3.2.1' }))
    expect(readVersionFromPackageDir(dir)).toBe('3.2.1')
  })

  it('missing package.json: returns undefined, never throws', () => {
    expect(readVersionFromPackageDir(join(dir, 'does-not-exist'))).toBeUndefined()
  })

  it('malformed JSON: returns undefined, never throws', () => {
    writeFileSync(join(dir, PACKAGE_JSON_FILENAME), '{ not valid json')
    expect(readVersionFromPackageDir(dir)).toBeUndefined()
  })

  it('non-string version field (a number): coerces to undefined rather than a non-string value', () => {
    writeFileSync(join(dir, PACKAGE_JSON_FILENAME), JSON.stringify({ name: 'x', version: 123 }))
    expect(readVersionFromPackageDir(dir)).toBeUndefined()
  })

  it('non-string version field (an object): coerces to undefined rather than "[object Object]"', () => {
    writeFileSync(
      join(dir, PACKAGE_JSON_FILENAME),
      JSON.stringify({ name: 'x', version: { major: 1 } })
    )
    expect(readVersionFromPackageDir(dir)).toBeUndefined()
  })

  it('version field entirely absent: returns undefined', () => {
    writeFileSync(join(dir, PACKAGE_JSON_FILENAME), JSON.stringify({ name: 'x' }))
    expect(readVersionFromPackageDir(dir)).toBeUndefined()
  })
})
