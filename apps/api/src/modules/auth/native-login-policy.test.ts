import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ExtensionState } from '../../extensions/loader.js'

const ENV_MODULE = '../../config/env.js'
const DEV_DUMMY_HASH_MODULE = '../../config/dev-dummy-hash.js'
const LATCH_MODULE = './native-login-latch.js'
const RLS_MODULE = '../../middleware/rls.js'
const DB_MODULE = '@project-vault/db'
const AUDIT_ROW_MODULE = '../../lib/system-audit-row.js'
const RECOVERY_LOOKUP_MODULE = './recovery-lookup.js'
// eslint-disable-next-line sonarjs/no-duplicate-string -- also appears as a `typeof import(...)` literal type, which TS requires inline
const POLICY_MODULE = './native-login-policy.js'
const TEST_API_VERSION = '1.2.0'

const EXTENSION_A_NAME = 'test.mock-envelope-extension'
const EXTENSION_B_NAME = 'test.mock-sso-extension'
const AUTH_PROVIDER_CAPABILITIES: ('auth-provider' | 'notification-channel' | 'ui-panel')[] = [
  'auth-provider',
]

const loadedDeclared = (): ExtensionState => ({
  status: 'loaded',
  manifest: {
    name: EXTENSION_A_NAME,
    apiVersion: TEST_API_VERSION,
    capabilities: AUTH_PROVIDER_CAPABILITIES,
    replacesNativeLogin: true,
  },
  loadedAt: new Date().toISOString(),
  hooks: { authStrategy: { onAuthenticate: vi.fn() } as never },
})

const loadedNotDeclared = (): ExtensionState => ({
  status: 'loaded',
  manifest: {
    name: EXTENSION_B_NAME,
    apiVersion: TEST_API_VERSION,
    capabilities: AUTH_PROVIDER_CAPABILITIES,
  },
  loadedAt: new Date().toISOString(),
  hooks: { authStrategy: { onAuthenticate: vi.fn() } as never },
})

// Story 23.2 fix (code review): a SECOND extension, distinct from `loadedDeclared()`'s
// EXTENSION_A_NAME, that also declares replacesNativeLogin — used to prove an extension swap
// (operator installs A, someone logs in through it proving A, then swaps to B) does not let B
// inherit A's proof.
const loadedDeclaredDifferentExtension = (): ExtensionState => ({
  status: 'loaded',
  manifest: {
    name: EXTENSION_B_NAME,
    apiVersion: TEST_API_VERSION,
    capabilities: AUTH_PROVIDER_CAPABILITIES,
    replacesNativeLogin: true,
  },
  loadedAt: new Date().toISOString(),
  hooks: { authStrategy: { onAuthenticate: vi.fn() } as never },
})

const notConfigured = (): ExtensionState => ({ status: 'not_configured' })
const loadFailed = (): ExtensionState => ({ status: 'load_failed', reason: 'manifest_invalid' })

const DEV_DUMMY_HASH = 'dev-dummy-hash-placeholder'
const SAFE_DUMMY_HASH = 'operator-set-unique-dummy-hash'

function mockEnvBreakGlassAndConfirmed(overrides?: {
  breakGlass?: boolean
  confirmed?: boolean
  // AC-6e item 3: defaults to a value distinct from DEV_AUTH_DUMMY_PASSWORD_HASH so the boot
  // check added for that AC does not spuriously fire in every other test in this file that
  // doesn't care about it.
  dummyPasswordHash?: string
}): void {
  vi.doMock(ENV_MODULE, () => ({
    env: {
      VAULT_NATIVE_LOGIN_BREAK_GLASS: overrides?.breakGlass ?? false,
      VAULT_NATIVE_LOGIN_REPLACEMENT_CONFIRMED: overrides?.confirmed ?? false,
      AUTH_DUMMY_PASSWORD_HASH: overrides?.dummyPasswordHash ?? SAFE_DUMMY_HASH,
    },
  }))
  vi.doMock(DEV_DUMMY_HASH_MODULE, () => ({ DEV_AUTH_DUMMY_PASSWORD_HASH: DEV_DUMMY_HASH }))
}

function mockCollaborators(latch: {
  readLatch: ReturnType<typeof vi.fn>
  writeLatch: ReturnType<typeof vi.fn>
  supersedeRecoveryTokens?: ReturnType<typeof vi.fn>
  writeAuditRow?: ReturnType<typeof vi.fn>
  fetchOrgIds?: ReturnType<typeof vi.fn>
}): void {
  vi.doMock(LATCH_MODULE, async () => {
    // isLatchProvenForExtension() is pure identity-matching logic (no DB access) — use the REAL
    // implementation here so this file's extension-scoping tests actually exercise it, rather
    // than mocking it away and only testing that the module calls into a stub.
    const actual = await vi.importActual<typeof import('./native-login-latch.js')>(LATCH_MODULE)
    return {
      readReplacementLatch: latch.readLatch,
      writeReplacementLatch: latch.writeLatch,
      markDisabledAnnouncedIfFirst: vi.fn().mockResolvedValue(true),
      isLatchProvenForExtension: actual.isLatchProvenForExtension,
    }
  })
  vi.doMock(RLS_MODULE, () => ({
    fetchAllOrgIds: latch.fetchOrgIds ?? vi.fn().mockResolvedValue([]),
  }))
  vi.doMock(DB_MODULE, () => ({
    withOrg: (_orgId: string, fn: (tx: unknown) => unknown) => fn({}),
  }))
  vi.doMock(AUDIT_ROW_MODULE, () => ({
    writeSystemAuditRow: latch.writeAuditRow ?? vi.fn().mockResolvedValue(undefined),
  }))
  vi.doMock(RECOVERY_LOOKUP_MODULE, () => ({
    supersedeAllPriorRecoveryTokensForExclusion:
      latch.supersedeRecoveryTokens ?? vi.fn().mockResolvedValue(undefined),
  }))
}

function unmockAll(): void {
  vi.doUnmock(ENV_MODULE)
  vi.doUnmock(DEV_DUMMY_HASH_MODULE)
  vi.doUnmock(LATCH_MODULE)
  vi.doUnmock(RLS_MODULE)
  vi.doUnmock(DB_MODULE)
  vi.doUnmock(AUDIT_ROW_MODULE)
  vi.doUnmock(RECOVERY_LOOKUP_MODULE)
}

describe('native-login-policy (Story 23.2 AC-4/AC-4a/AC-5/AC-7)', () => {
  let mod: typeof import('./native-login-policy.js')
  let env: typeof import('../../config/env.js').env
  let readLatch: ReturnType<typeof vi.fn>
  let writeLatch: ReturnType<typeof vi.fn>
  let supersedeRecoveryTokens: ReturnType<typeof vi.fn>
  let writeAuditRow: ReturnType<typeof vi.fn>
  let fetchOrgIds: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    mockEnvBreakGlassAndConfirmed()
    readLatch = vi.fn().mockResolvedValue(null)
    writeLatch = vi.fn().mockResolvedValue(undefined)
    supersedeRecoveryTokens = vi.fn().mockResolvedValue(undefined)
    writeAuditRow = vi.fn().mockResolvedValue(undefined)
    fetchOrgIds = vi.fn().mockResolvedValue(['org-1', 'org-2'])
    mockCollaborators({
      readLatch,
      writeLatch,
      supersedeRecoveryTokens,
      writeAuditRow,
      fetchOrgIds,
    })
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

  it('AC-7: resolveNativeLoginPolicy() itself throwing during resolution fails safe to enabled, fatal-logged, never leaves policy unresolved', async () => {
    readLatch.mockRejectedValue(new Error('simulated bug in resolution logic'))
    await expect(mod.resolveNativeLoginPolicy(loadedDeclared())).resolves.toBeUndefined()
    expect(mod.isNativeLoginEnabled()).toBe(true)
    const state = mod.getNativeLoginPolicyState()
    expect(state.state).toBe('enabled')
    expect(state.replacementDeclared).toBe(false)
  })

  it('declared but never proven: enabled, state=replacement_declared_unproven (AC-4a)', async () => {
    await mod.resolveNativeLoginPolicy(loadedDeclared())
    expect(mod.isNativeLoginEnabled()).toBe(true)
    expect(mod.getNativeLoginPolicyState().state).toBe('replacement_declared_unproven')
  })

  it('declared AND proven (latch row present at boot): disabled (AC-4 positive example)', async () => {
    readLatch.mockResolvedValue({
      replacementProvenAt: new Date().toISOString(),
      provenByExtension: EXTENSION_A_NAME,
    })
    await mod.resolveNativeLoginPolicy(loadedDeclared())
    expect(mod.isNativeLoginEnabled()).toBe(false)
    expect(mod.getNativeLoginPolicyState().state).toBe('disabled')
  })

  // Story 23.2 fix (code review, critical finding): extension A gets proven (someone logs in
  // through it), the operator later swaps to extension B — which also declares
  // replacesNativeLogin but has NEVER itself authenticated anyone on this instance. Before this
  // fix, the latch was a bare timestamp with no extension identity, so B would inherit A's stale
  // proof and native login would resolve to 'disabled' on B's very first boot even though B's
  // own auth strategy has never been shown to work. This must resolve exactly like the
  // never-proven case: enabled, state=replacement_declared_unproven.
  it('extension swap: a latch proven by a DIFFERENT extension does not carry over — resolves enabled/unproven, not disabled', async () => {
    readLatch.mockResolvedValue({
      replacementProvenAt: new Date().toISOString(),
      provenByExtension: EXTENSION_A_NAME, // extension A proved it
    })
    // Operator has swapped to extension B — never itself proven.
    await mod.resolveNativeLoginPolicy(loadedDeclaredDifferentExtension())
    expect(mod.isNativeLoginEnabled()).toBe(true)
    const diagnostics = mod.getNativeLoginPolicyState()
    expect(diagnostics.state).toBe('replacement_declared_unproven')
    expect(diagnostics.replacementProven).toBe(false)
    expect(diagnostics.replacementProvenAt).toBeNull()
  })

  // A pre-fix row (proven, but no extension identity recorded — the column did not exist yet)
  // must be treated the same way: unproven for whatever is loaded now, never trusted blindly.
  it('extension swap: a legacy latch row with no recorded extension identity is treated as unproven', async () => {
    readLatch.mockResolvedValue({
      replacementProvenAt: new Date().toISOString(),
      provenByExtension: null,
    })
    await mod.resolveNativeLoginPolicy(loadedDeclared())
    expect(mod.isNativeLoginEnabled()).toBe(true)
    expect(mod.getNativeLoginPolicyState().state).toBe('replacement_declared_unproven')
  })

  it('AC-6 pre-staging retroactive close: sweeps recovery tokens on a disabled boot', async () => {
    readLatch.mockResolvedValue({
      replacementProvenAt: new Date().toISOString(),
      provenByExtension: EXTENSION_A_NAME,
    })
    await mod.resolveNativeLoginPolicy(loadedDeclared())
    expect(mod.getNativeLoginPolicyState().state).toBe('disabled')
    expect(supersedeRecoveryTokens).toHaveBeenCalledTimes(1)
  })

  it('AC-6 pre-staging retroactive close: does NOT sweep on a boot that stays enabled', async () => {
    await mod.resolveNativeLoginPolicy(loadedNotDeclared())
    expect(mod.isNativeLoginEnabled()).toBe(true)
    expect(supersedeRecoveryTokens).not.toHaveBeenCalled()
  })

  it('AC-6 pre-staging retroactive close: a sweep failure never fails policy resolution', async () => {
    supersedeRecoveryTokens.mockRejectedValue(new Error('db down'))
    readLatch.mockResolvedValue({
      replacementProvenAt: new Date().toISOString(),
      provenByExtension: EXTENSION_A_NAME,
    })
    await expect(mod.resolveNativeLoginPolicy(loadedDeclared())).resolves.toBeUndefined()
    expect(mod.getNativeLoginPolicyState().state).toBe('disabled')
  })

  it('declared, unproven, but VAULT_NATIVE_LOGIN_REPLACEMENT_CONFIRMED=true: disabled', async () => {
    env.VAULT_NATIVE_LOGIN_REPLACEMENT_CONFIRMED = true
    await mod.resolveNativeLoginPolicy(loadedDeclared())
    expect(mod.isNativeLoginEnabled()).toBe(false)
  })

  it('declared and proven, but break-glass set: enabled, state=break_glass (AC-8)', async () => {
    readLatch.mockResolvedValue({
      replacementProvenAt: new Date().toISOString(),
      provenByExtension: EXTENSION_A_NAME,
    })
    env.VAULT_NATIVE_LOGIN_BREAK_GLASS = true
    await mod.resolveNativeLoginPolicy(loadedDeclared())
    expect(mod.isNativeLoginEnabled()).toBe(true)
    expect(mod.getNativeLoginPolicyState().state).toBe('break_glass')
  })

  it('AC-16/AC-8 H7 resolution: break-glass set on an extension-less boot warns but writes ZERO audit rows', async () => {
    env.VAULT_NATIVE_LOGIN_BREAK_GLASS = true
    await mod.resolveNativeLoginPolicy(notConfigured())
    expect(mod.getNativeLoginPolicyState().state).toBe('break_glass')
    expect(writeAuditRow).not.toHaveBeenCalled()
  })

  it('AC-8 H7 resolution (other half): break-glass set AND the extension declares replacement fans the audit event out per org', async () => {
    env.VAULT_NATIVE_LOGIN_BREAK_GLASS = true
    await mod.resolveNativeLoginPolicy(loadedDeclared())
    expect(mod.getNativeLoginPolicyState().state).toBe('break_glass')
    expect(fetchOrgIds).toHaveBeenCalledTimes(1)
    expect(writeAuditRow).toHaveBeenCalledTimes(2)
    expect(writeAuditRow).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ orgId: 'org-1', eventType: 'native_login.break_glass_active' })
    )
  })

  it('AC-6e item 3: the in-repo dummy-hash default is safe (only warns) when state stays enabled', async () => {
    env.AUTH_DUMMY_PASSWORD_HASH = DEV_DUMMY_HASH
    await expect(mod.resolveNativeLoginPolicy(notConfigured())).resolves.toBeUndefined()
    expect(mod.isNativeLoginEnabled()).toBe(true)
  })

  it('AC-6e item 3: boot FAILS when the in-repo dummy-hash default is still set and the state is not plain enabled', async () => {
    env.AUTH_DUMMY_PASSWORD_HASH = DEV_DUMMY_HASH
    await expect(mod.resolveNativeLoginPolicy(loadedDeclared())).rejects.toThrow(
      /AUTH_DUMMY_PASSWORD_HASH/
    )
  })

  it('AC-6e item 3: an operator-set, non-default dummy hash never fails boot regardless of state', async () => {
    readLatch.mockResolvedValue({
      replacementProvenAt: new Date().toISOString(),
      provenByExtension: EXTENSION_A_NAME,
    })
    // env.AUTH_DUMMY_PASSWORD_HASH stays at the default mock value (SAFE_DUMMY_HASH), distinct
    // from DEV_AUTH_DUMMY_PASSWORD_HASH — resolves to the 'disabled' state below, which would
    // have thrown above had the hash still been the in-repo default.
    await expect(mod.resolveNativeLoginPolicy(loadedDeclared())).resolves.toBeUndefined()
    expect(mod.getNativeLoginPolicyState().state).toBe('disabled')
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
    await mod.markReplacementProven(EXTENSION_A_NAME)
    expect(mod.isNativeLoginEnabled()).toBe(true)
    expect(mod.getNativeLoginPolicyState()).toBe(before)
    expect(writeLatch).toHaveBeenCalledTimes(1)
  })

  it('markReplacementProven() is a no-op (does not re-write) once the latch is already set', async () => {
    readLatch.mockResolvedValue({
      replacementProvenAt: new Date().toISOString(),
      provenByExtension: EXTENSION_A_NAME,
    })
    await mod.resolveNativeLoginPolicy(loadedDeclared())
    await mod.markReplacementProven(EXTENSION_A_NAME)
    // Still calls the idempotent ON CONFLICT DO NOTHING writer — monotonicity is enforced by
    // the storage layer, not by skipping the call.
    expect(writeLatch).toHaveBeenCalledTimes(1)
  })

  it('a failed latch write never throws and never disables native login', async () => {
    writeLatch.mockRejectedValue(new Error('db down'))
    await mod.resolveNativeLoginPolicy(loadedDeclared())
    await expect(mod.markReplacementProven(EXTENSION_A_NAME)).resolves.toBeUndefined()
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
      readLatch: vi.fn().mockResolvedValue({
        replacementProvenAt: new Date().toISOString(),
        provenByExtension: EXTENSION_A_NAME,
      }),
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
