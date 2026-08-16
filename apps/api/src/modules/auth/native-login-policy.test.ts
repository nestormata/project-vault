import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ExtensionState } from '../../extensions/loader.js'

const ENV_MODULE = '../../config/env.js'
const LATCH_MODULE = './native-login-latch.js'
const RLS_MODULE = '../../middleware/rls.js'
const DB_MODULE = '@project-vault/db'
const AUDIT_ROW_MODULE = '../../lib/system-audit-row.js'
// eslint-disable-next-line sonarjs/no-duplicate-string -- also appears as a `typeof import(...)` literal type, which TS requires inline
const POLICY_MODULE = './native-login-policy.js'
const TEST_API_VERSION = '1.2.0'

const loadedDeclared = (): ExtensionState => ({
  status: 'loaded',
  manifest: {
    name: 'test.mock-envelope-extension',
    apiVersion: TEST_API_VERSION,
    capabilities: ['auth-provider'],
    replacesNativeLogin: true,
  },
  loadedAt: new Date().toISOString(),
  hooks: { authStrategy: { onAuthenticate: vi.fn() } as never },
})

const loadedNotDeclared = (): ExtensionState => ({
  status: 'loaded',
  manifest: {
    name: 'test.mock-sso-extension',
    apiVersion: TEST_API_VERSION,
    capabilities: ['auth-provider'],
  },
  loadedAt: new Date().toISOString(),
  hooks: { authStrategy: { onAuthenticate: vi.fn() } as never },
})

const notConfigured = (): ExtensionState => ({ status: 'not_configured' })
const loadFailed = (): ExtensionState => ({ status: 'load_failed', reason: 'manifest_invalid' })

function mockEnvBreakGlassAndConfirmed(overrides?: {
  breakGlass?: boolean
  confirmed?: boolean
}): void {
  vi.doMock(ENV_MODULE, () => ({
    env: {
      VAULT_NATIVE_LOGIN_BREAK_GLASS: overrides?.breakGlass ?? false,
      VAULT_NATIVE_LOGIN_REPLACEMENT_CONFIRMED: overrides?.confirmed ?? false,
    },
  }))
}

function mockCollaborators(latch: {
  readLatch: ReturnType<typeof vi.fn>
  writeLatch: ReturnType<typeof vi.fn>
}): void {
  vi.doMock(LATCH_MODULE, () => ({
    readReplacementLatch: latch.readLatch,
    writeReplacementLatch: latch.writeLatch,
    markDisabledAnnouncedIfFirst: vi.fn().mockResolvedValue(true),
  }))
  vi.doMock(RLS_MODULE, () => ({ fetchAllOrgIds: vi.fn().mockResolvedValue([]) }))
  vi.doMock(DB_MODULE, () => ({ withOrg: vi.fn() }))
  vi.doMock(AUDIT_ROW_MODULE, () => ({ writeSystemAuditRow: vi.fn() }))
}

function unmockAll(): void {
  vi.doUnmock(ENV_MODULE)
  vi.doUnmock(LATCH_MODULE)
  vi.doUnmock(RLS_MODULE)
  vi.doUnmock(DB_MODULE)
  vi.doUnmock(AUDIT_ROW_MODULE)
}

describe('native-login-policy (Story 23.2 AC-4/AC-4a/AC-5/AC-7)', () => {
  let mod: typeof import('./native-login-policy.js')
  let env: typeof import('../../config/env.js').env
  let readLatch: ReturnType<typeof vi.fn>
  let writeLatch: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    mockEnvBreakGlassAndConfirmed()
    readLatch = vi.fn().mockResolvedValue(null)
    writeLatch = vi.fn().mockResolvedValue(undefined)
    mockCollaborators({ readLatch, writeLatch })
    mod = await import(POLICY_MODULE)
    env = (await import(ENV_MODULE)).env
  })

  afterEach(unmockAll)

  it('throws if isNativeLoginEnabled() is called before resolution', () => {
    expect(() => mod.isNativeLoginEnabled()).toThrow()
  })

  it('no extension loaded: enabled, state=enabled (AC-7 row: not_configured)', async () => {
    await mod.resolveNativeLoginPolicy(notConfigured())
    expect(mod.isNativeLoginEnabled()).toBe(true)
    expect(mod.getNativeLoginPolicyState().state).toBe('enabled')
  })

  it('extension failed to load: enabled, state=enabled (AC-7 row: load_failed)', async () => {
    await mod.resolveNativeLoginPolicy(loadFailed())
    expect(mod.isNativeLoginEnabled()).toBe(true)
    expect(mod.getNativeLoginPolicyState().extensionStatus).toBe('load_failed')
  })

  it('loaded but does not declare replacement: enabled', async () => {
    await mod.resolveNativeLoginPolicy(loadedNotDeclared())
    expect(mod.isNativeLoginEnabled()).toBe(true)
    expect(mod.getNativeLoginPolicyState().replacementDeclared).toBe(false)
  })

  it('declared but never proven: enabled, state=replacement_declared_unproven (AC-4a)', async () => {
    await mod.resolveNativeLoginPolicy(loadedDeclared())
    expect(mod.isNativeLoginEnabled()).toBe(true)
    expect(mod.getNativeLoginPolicyState().state).toBe('replacement_declared_unproven')
  })

  it('declared AND proven (latch row present at boot): disabled (AC-4 positive example)', async () => {
    readLatch.mockResolvedValue({ replacementProvenAt: new Date().toISOString() })
    await mod.resolveNativeLoginPolicy(loadedDeclared())
    expect(mod.isNativeLoginEnabled()).toBe(false)
    expect(mod.getNativeLoginPolicyState().state).toBe('disabled')
  })

  it('declared, unproven, but VAULT_NATIVE_LOGIN_REPLACEMENT_CONFIRMED=true: disabled', async () => {
    env.VAULT_NATIVE_LOGIN_REPLACEMENT_CONFIRMED = true
    await mod.resolveNativeLoginPolicy(loadedDeclared())
    expect(mod.isNativeLoginEnabled()).toBe(false)
  })

  it('declared and proven, but break-glass set: enabled, state=break_glass (AC-8)', async () => {
    readLatch.mockResolvedValue({ replacementProvenAt: new Date().toISOString() })
    env.VAULT_NATIVE_LOGIN_BREAK_GLASS = true
    await mod.resolveNativeLoginPolicy(loadedDeclared())
    expect(mod.isNativeLoginEnabled()).toBe(true)
    expect(mod.getNativeLoginPolicyState().state).toBe('break_glass')
  })

  it('freezes the resolved policy object', async () => {
    await mod.resolveNativeLoginPolicy(loadedDeclared())
    const state = mod.getNativeLoginPolicyState()
    expect(Object.isFrozen(state)).toBe(true)
  })

  it('is idempotent under double-invocation (createApp() called twice in one process)', async () => {
    await mod.resolveNativeLoginPolicy(loadedDeclared())
    const first = mod.getNativeLoginPolicyState()
    await mod.resolveNativeLoginPolicy(notConfigured())
    const second = mod.getNativeLoginPolicyState()
    expect(second).toBe(first)
    expect(readLatch).toHaveBeenCalledTimes(1)
  })

  it('__resetNativeLoginPolicyForTests() allows re-resolution', async () => {
    await mod.resolveNativeLoginPolicy(loadedDeclared())
    mod.__resetNativeLoginPolicyForTests()
    await mod.resolveNativeLoginPolicy(notConfigured())
    expect(mod.isNativeLoginEnabled()).toBe(true)
  })

  it('markReplacementProven() never mutates the frozen in-process policy (N3/N11 regression guard)', async () => {
    await mod.resolveNativeLoginPolicy(loadedDeclared())
    expect(mod.isNativeLoginEnabled()).toBe(true)
    const before = mod.getNativeLoginPolicyState()
    await mod.markReplacementProven()
    expect(mod.isNativeLoginEnabled()).toBe(true)
    expect(mod.getNativeLoginPolicyState()).toBe(before)
    expect(writeLatch).toHaveBeenCalledTimes(1)
  })

  it('markReplacementProven() is a no-op (does not re-write) once the latch is already set', async () => {
    readLatch.mockResolvedValue({ replacementProvenAt: new Date().toISOString() })
    await mod.resolveNativeLoginPolicy(loadedDeclared())
    await mod.markReplacementProven()
    // Still calls the idempotent ON CONFLICT DO NOTHING writer — monotonicity is enforced by
    // the storage layer, not by skipping the call.
    expect(writeLatch).toHaveBeenCalledTimes(1)
  })

  it('a failed latch write never throws and never disables native login', async () => {
    writeLatch.mockRejectedValue(new Error('db down'))
    await mod.resolveNativeLoginPolicy(loadedDeclared())
    await expect(mod.markReplacementProven()).resolves.toBeUndefined()
    expect(mod.isNativeLoginEnabled()).toBe(true)
  })

  it('exports exactly the sanctioned state-management surface (AC-4a export-surface test)', () => {
    const exported = Object.keys(mod).sort()
    expect(exported).toEqual(
      [
        '__resetNativeLoginPolicyForTests',
        'getNativeLoginPolicyState',
        'isNativeLoginEnabled',
        'markReplacementProven',
        'nativeCredentialGatePreHandler',
        'resolveNativeLoginPolicy',
      ].sort()
    )
  })
})

describe('nativeCredentialGatePreHandler (Story 23.2 AC-6)', () => {
  let mod: typeof import('./native-login-policy.js')

  beforeEach(async () => {
    vi.resetModules()
    mockEnvBreakGlassAndConfirmed()
    mockCollaborators({ readLatch: vi.fn().mockResolvedValue(null), writeLatch: vi.fn() })
    mod = await import(POLICY_MODULE)
  })

  afterEach(unmockAll)

  it('lets the request through when native login is enabled', async () => {
    await mod.resolveNativeLoginPolicy(notConfigured())
    const reply = { status: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis() }
    const result = mod.nativeCredentialGatePreHandler({ url: '/x' } as never, reply as never)
    expect(result).toBeUndefined()
    expect(reply.status).not.toHaveBeenCalled()
  })

  it('returns 403 native_login_disabled before any credential work when disabled', async () => {
    vi.resetModules()
    mockEnvBreakGlassAndConfirmed()
    mockCollaborators({
      readLatch: vi.fn().mockResolvedValue({ replacementProvenAt: new Date().toISOString() }),
      writeLatch: vi.fn(),
    })
    const freshMod = await import(POLICY_MODULE)
    await freshMod.resolveNativeLoginPolicy(loadedDeclared())
    const reply = { status: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis() }
    freshMod.nativeCredentialGatePreHandler({ url: '/api/v1/auth/login' } as never, reply as never)
    expect(reply.status).toHaveBeenCalledWith(403)
    expect(reply.send).toHaveBeenCalledWith({
      code: 'native_login_disabled',
      message: expect.any(String),
    })
  })
})
