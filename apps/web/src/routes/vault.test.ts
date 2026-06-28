import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildVaultInitRequest,
  buildVaultUnsealRequest,
  clearVaultInitFields,
  clearVaultUnsealFields,
} from '$lib/components/vault/form-model.js'
import { getVaultGateModel } from '$lib/components/vault/gate-model.js'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('vault operator UI', () => {
  it('uninitialized shows only the init action', () => {
    const model = getVaultGateModel({
      state: 'uninitialized',
      message: 'Vault not initialized. POST /api/v1/vault/init to initialize.',
    })

    expect(model.primaryAction).toBe('Initialize vault')
    expect(model.showInit).toBe(true)
    expect(model.showUnseal).toBe(false)
  })

  it('sealed shows only the unseal action', () => {
    const model = getVaultGateModel({
      state: 'sealed',
      message: 'Manual unseal required via POST /api/v1/vault/unseal',
    })

    expect(model.primaryAction).toBe('Unseal vault')
    expect(model.showInit).toBe(false)
    expect(model.showUnseal).toBe(true)
  })

  it('unavailable shows retry only', () => {
    const model = getVaultGateModel({
      state: 'unavailable',
      message: 'Project Vault is not ready yet. Try again shortly.',
    })

    expect(model.primaryAction).toBe('Retry readiness')
    expect(model.showInit).toBe(false)
    expect(model.showUnseal).toBe(false)
  })

  it('init form model keeps bootstrap token separate and clears sensitive fields', async () => {
    const submit = vi.fn().mockResolvedValue(undefined)
    const fields = {
      bootstrapToken: 'bootstrap-token-value',
      mode: 'passphrase' as const,
      passphrase: 'correct-horse-battery-staple',
      envelopeKeyPath: '',
      masterKeyPath: '',
    }
    const request = buildVaultInitRequest(fields)
    await submit(request, fields.bootstrapToken)

    expect(submit).toHaveBeenCalledWith(
      { kmsType: 'passphrase', passphrase: 'correct-horse-battery-staple' },
      'bootstrap-token-value'
    )
    expect(clearVaultInitFields(fields)).toEqual({
      bootstrapToken: '',
      mode: 'passphrase',
      passphrase: '',
      envelopeKeyPath: '',
      masterKeyPath: '',
    })
  })

  it('unseal form model submits one selected material field and clears it', async () => {
    const submit = vi.fn().mockResolvedValue(undefined)
    const fields = {
      mode: 'passphrase' as const,
      passphrase: 'correct-horse-battery-staple',
      envelopeKeyPath: '',
      masterKeyPath: '',
    }
    const request = buildVaultUnsealRequest(fields)
    await submit(request)

    expect(submit).toHaveBeenCalledWith({ passphrase: 'correct-horse-battery-staple' })
    expect(clearVaultUnsealFields(fields)).toEqual({
      mode: 'passphrase',
      passphrase: '',
      envelopeKeyPath: '',
      masterKeyPath: '',
    })
  })
})
