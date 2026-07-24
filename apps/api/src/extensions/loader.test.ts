import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ExtensionRegistrationError } from '@project-vault/extension-api'
import type { ExtensionHooks, ExtensionManifest } from '@project-vault/extension-api'
import {
  __resetExtensionStateForTests,
  getExtensionStatus,
  getExtensionsHealthField,
  loadExtension,
} from './loader.js'
import type { LoadExtensionDeps } from './loader.js'

const VALID_MANIFEST: ExtensionManifest = {
  name: 'com.acme.sso-extension',
  apiVersion: '^1.0.0',
  capabilities: ['auth-provider'],
}

const NOOP_HOOKS: ExtensionHooks = {}
const VALID_PACKAGE_NAME = '@acme/extension'
const BAD_PACKAGE_NAME = 'bad-package'

function noopLogger(): LoadExtensionDeps['logger'] {
  return { warn: vi.fn(), fatal: vi.fn() }
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
    const logger = { warn: vi.fn(), fatal }

    await loadExtension(BAD_PACKAGE_NAME, baseDeps({ importFn, logger }))

    expect(fatal).toHaveBeenCalledTimes(1)
    const [payload] = fatal.mock.calls[0] as [Record<string, unknown>, string]
    expect(payload['reason']).toBe('import_error')
    expect(payload).not.toHaveProperty('err')
    expect(payload).not.toHaveProperty('stack')
    expect(payload).not.toHaveProperty('message')
    expect(JSON.stringify(payload)).not.toContain('/secret/internal/path')
  })
})

describe('getExtensionStatus / getExtensionsHealthField', () => {
  it('default state is not_configured', () => {
    expect(getExtensionStatus()).toEqual({ status: 'not_configured' })
    expect(getExtensionsHealthField()).toBe('not_configured')
  })
})
