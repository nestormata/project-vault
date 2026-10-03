import { afterEach, describe, expect, it, vi } from 'vitest'
import { OperationalEvent } from '@project-vault/shared'
import { ExtensionApiRouteBootError } from '../lib/secure-route-overrides.js'
import {
  ExtensionRequiredError,
  assertExtensionRequirement,
  findExtensionBootFailure,
} from './boot-errors.js'
import { __resetExtensionStateForTests, getExtensionStatus, loadExtension } from './loader.js'

describe('Story 68.8 AC-11 — VAULT_EXTENSIONS_REQUIRED', () => {
  afterEach(() => {
    __resetExtensionStateForTests()
  })

  it('not required: every state passes (fail-open, today’s behaviour)', () => {
    for (const state of [
      { status: 'not_configured' as const },
      { status: 'load_failed' as const, reason: 'import_error' as const },
    ]) {
      expect(() =>
        assertExtensionRequirement({ required: false, packageName: undefined, state })
      ).not.toThrow()
      expect(() =>
        assertExtensionRequirement({ required: undefined, packageName: 'x', state })
      ).not.toThrow()
    }
  })

  it('required with no package configured fails with extension_required_not_configured (Q4)', () => {
    let caught: unknown
    try {
      assertExtensionRequirement({
        required: true,
        packageName: undefined,
        state: { status: 'not_configured' },
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ExtensionRequiredError)
    expect((caught as ExtensionRequiredError).reason).toBe('extension_required_not_configured')
    expect((caught as Error).message).toBe(
      'VAULT_EXTENSIONS_REQUIRED is true but VAULT_EXTENSIONS_PACKAGE is not set'
    )
  })

  it.each(['import_error', 'manifest_invalid', 'capability_mismatch'] as const)(
    'required with a %s load failure fails with extension_required_load_failed',
    (loadFailureReason) => {
      let caught: unknown
      try {
        assertExtensionRequirement({
          required: true,
          packageName: '@acme/pack',
          state: { status: 'load_failed', reason: loadFailureReason },
        })
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(ExtensionRequiredError)
      expect(caught).toMatchObject({ reason: 'extension_required_load_failed', loadFailureReason })
    }
  )

  it('required with a loaded extension passes', () => {
    expect(() =>
      assertExtensionRequirement({
        required: true,
        packageName: '@acme/pack',
        state: {
          status: 'loaded',
          manifest: { name: 'com.acme.pack', apiVersion: '3.27.0', capabilities: [] },
          hooks: {},
          loadedAt: new Date().toISOString(),
        },
      })
    ).not.toThrow()
  })

  it('the loader does not claim "continuing without it" when the extension is required', async () => {
    const fatal = vi.fn()
    const logger = { warn: vi.fn(), error: vi.fn(), fatal }
    await loadExtension('@acme/missing', {
      importFn: () => Promise.reject(new Error('not found')),
      listOrgIds: async () => [],
      logger: logger as never,
      required: true,
    })
    expect(getExtensionStatus()).toEqual({ status: 'load_failed', reason: 'import_error' })
    expect(fatal).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: OperationalEvent.EXTENSION_LOAD_FAILED }),
      'Extension failed to load — VAULT_EXTENSIONS_REQUIRED is true, the API will not start'
    )
  })

  it('the loader keeps its fail-open message when not required', async () => {
    const fatal = vi.fn()
    await loadExtension('@acme/missing', {
      importFn: () => Promise.reject(new Error('not found')),
      listOrgIds: async () => [],
      logger: { warn: vi.fn(), error: vi.fn(), fatal } as never,
    })
    expect(fatal).toHaveBeenCalledWith(
      expect.anything(),
      'Extension failed to load — API continuing without it'
    )
  })
})

describe('Story 68.8 Q15 — findExtensionBootFailure walks the error chain', () => {
  it('finds a required-mode failure with its load failure reason', () => {
    const error = new ExtensionRequiredError(
      'extension_required_load_failed',
      'boom',
      'import_error'
    )
    expect(findExtensionBootFailure(error)).toEqual({
      reason: 'extension_required_load_failed',
      loadFailureReason: 'import_error',
    })
  })

  it('finds an apiRoutes boot error wrapped as a cause', () => {
    const inner = new ExtensionApiRouteBootError('extension_api_route_drift', 'drift')
    expect(findExtensionBootFailure(new Error('outer', { cause: inner }))).toEqual({
      reason: 'extension_api_route_drift',
    })
  })

  it('is undefined for an unrelated error, a non-error and a cyclic chain', () => {
    expect(findExtensionBootFailure(new Error('listen failed'))).toBeUndefined()
    expect(findExtensionBootFailure('text')).toBeUndefined()
    const cyclic = new Error('a') as Error & { cause?: unknown }
    cyclic.cause = cyclic
    expect(findExtensionBootFailure(cyclic)).toBeUndefined()
  })
})
