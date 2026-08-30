import { beforeEach, describe, expect, it, vi } from 'vitest'

const PV_INSTANCE_ID = 'pv-instance-1'

const { registerAuthStrategy } = vi.hoisted(() => ({ registerAuthStrategy: vi.fn() }))
const { isNativeLoginEnabled } = vi.hoisted(() => ({ isNativeLoginEnabled: vi.fn() }))
const state = vi.hoisted(() => ({
  env: { VAULT_HANDOFF_ENABLED: false, VAULT_HANDOFF_INSTANCE_ID: undefined as string | undefined },
  handoffVerifyKeys: [] as { kid: string; publicKeyPem: string }[],
}))

vi.mock('./strategies.js', () => ({ registerAuthStrategy }))
vi.mock('./native-login-policy.js', () => ({ isNativeLoginEnabled }))
vi.mock('../../config/env.js', () => ({
  get env() {
    return state.env
  },
  get handoffVerifyKeys() {
    return state.handoffVerifyKeys
  },
}))

async function loadModule() {
  return import('./handoff-boot.js')
}

describe('resolveHandoffAuthStrategy (Story 30.2 AC2)', () => {
  beforeEach(() => {
    registerAuthStrategy.mockReset()
    isNativeLoginEnabled.mockReset()
    state.env.VAULT_HANDOFF_ENABLED = false
    state.env.VAULT_HANDOFF_INSTANCE_ID = undefined
    state.handoffVerifyKeys = []
  })

  it('AC2.4 happy path: registers the strategy when enabled + instance id + non-empty key set are present', async () => {
    state.env.VAULT_HANDOFF_ENABLED = true
    state.env.VAULT_HANDOFF_INSTANCE_ID = PV_INSTANCE_ID
    state.handoffVerifyKeys = [{ kid: 'k1', publicKeyPem: 'pem' }]
    const mod = await loadModule()
    await mod.resolveHandoffAuthStrategy({})
    expect(registerAuthStrategy).toHaveBeenCalledWith(
      'centralizeme-handoff',
      expect.objectContaining({ onAuthenticate: expect.any(Function) })
    )
  })

  it('AC2.4 dummy strategy never actually authenticates anything (no route dispatches through it)', async () => {
    state.env.VAULT_HANDOFF_ENABLED = true
    state.env.VAULT_HANDOFF_INSTANCE_ID = PV_INSTANCE_ID
    state.handoffVerifyKeys = [{ kid: 'k1', publicKeyPem: 'pem' }]
    const mod = await loadModule()
    await mod.resolveHandoffAuthStrategy({})
    const [, strategy] = registerAuthStrategy.mock.calls[0] as [
      string,
      { onAuthenticate: (c: string) => Promise<unknown> },
    ]
    await expect(strategy.onAuthenticate('anything')).rejects.toThrow()
  })

  it('no-ops silently when VAULT_HANDOFF_ENABLED is false, regardless of config presence', async () => {
    state.env.VAULT_HANDOFF_ENABLED = false
    state.env.VAULT_HANDOFF_INSTANCE_ID = undefined
    const mod = await loadModule()
    await mod.resolveHandoffAuthStrategy({})
    expect(registerAuthStrategy).not.toHaveBeenCalled()
    expect(isNativeLoginEnabled).not.toHaveBeenCalled()
  })

  it('AC2.5 fail-safe branch: enabled but missing instance id + native login still enabled -> fatal log, no throw', async () => {
    state.env.VAULT_HANDOFF_ENABLED = true
    state.env.VAULT_HANDOFF_INSTANCE_ID = undefined
    isNativeLoginEnabled.mockReturnValue(true)
    const mod = await loadModule()
    const fatal = vi.fn()
    await expect(mod.resolveHandoffAuthStrategy({ fatal })).resolves.toBeUndefined()
    expect(registerAuthStrategy).not.toHaveBeenCalled()
    expect(fatal).toHaveBeenCalled()
  })

  it('AC2.5 fail-safe branch also fires when instance id present but key set empty', async () => {
    state.env.VAULT_HANDOFF_ENABLED = true
    state.env.VAULT_HANDOFF_INSTANCE_ID = PV_INSTANCE_ID
    state.handoffVerifyKeys = []
    isNativeLoginEnabled.mockReturnValue(true)
    const mod = await loadModule()
    const fatal = vi.fn()
    await mod.resolveHandoffAuthStrategy({ fatal })
    expect(registerAuthStrategy).not.toHaveBeenCalled()
    expect(fatal).toHaveBeenCalled()
  })

  it('AC2.5 fail-loud branch: enabled but misconfigured + native login excluded -> throws (refuse to boot)', async () => {
    state.env.VAULT_HANDOFF_ENABLED = true
    state.env.VAULT_HANDOFF_INSTANCE_ID = undefined
    isNativeLoginEnabled.mockReturnValue(false)
    const mod = await loadModule()
    await expect(mod.resolveHandoffAuthStrategy({})).rejects.toThrow()
    expect(registerAuthStrategy).not.toHaveBeenCalled()
  })

  it('AC2.6 regression: does not register a second time / does not throw the registry double-registration error itself (registerAuthStrategy is trusted to guard)', async () => {
    state.env.VAULT_HANDOFF_ENABLED = true
    state.env.VAULT_HANDOFF_INSTANCE_ID = PV_INSTANCE_ID
    state.handoffVerifyKeys = [{ kid: 'k1', publicKeyPem: 'pem' }]
    const mod = await loadModule()
    await mod.resolveHandoffAuthStrategy({})
    expect(registerAuthStrategy).toHaveBeenCalledTimes(1)
  })
})
