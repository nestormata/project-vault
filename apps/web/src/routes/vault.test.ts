import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildVaultInitRequest,
  buildVaultUnsealRequest,
  clearVaultInitFields,
  clearVaultUnsealFields,
} from '$lib/components/vault/form-model.js'
import { getVaultGateModel } from '$lib/components/vault/gate-model.js'

const routeRoot = resolve(dirname(fileURLToPath(import.meta.url)))

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

  describe('AC-9/10/11: sealed-vault (and sibling states) plain-language explanation', () => {
    it('AC-10: uninitialized has a static explanation distinct from sealed/unavailable', () => {
      const model = getVaultGateModel({ state: 'uninitialized', message: 'api says hi' })

      expect(model.explanation.length).toBeGreaterThan(0)
      expect(model.explanation.toLowerCase()).toContain('never been set up')
    })

    it('AC-9: sealed has a static explanation of what "sealed" means', () => {
      const model = getVaultGateModel({ state: 'sealed', message: 'api says hi' })

      expect(model.explanation.length).toBeGreaterThan(0)
      expect(model.explanation.toLowerCase()).toContain('encryption key')
      expect(model.explanation.toLowerCase()).toContain('not currently loaded into memory')
    })

    it('AC-10: unavailable has its own distinct static explanation', () => {
      const model = getVaultGateModel({ state: 'unavailable', message: 'api says hi' })

      expect(model.explanation.length).toBeGreaterThan(0)
      expect(model.explanation).not.toBe(
        getVaultGateModel({ state: 'sealed', message: '' }).explanation
      )
      expect(model.explanation).not.toBe(
        getVaultGateModel({ state: 'uninitialized', message: '' }).explanation
      )
    })

    it('AC-11: the explanation is present even when the API message is an empty string', () => {
      const model = getVaultGateModel({ state: 'sealed', message: '' })

      expect(model.explanation.length).toBeGreaterThan(0)
    })

    it('AC-11: the explanation is present even when the API message is undefined', () => {
      const model = getVaultGateModel({
        state: 'sealed',
        message: undefined as unknown as string,
      })

      expect(model.explanation.length).toBeGreaterThan(0)
    })
  })

  it('mounts vault gate in a user-visible vault route', () => {
    const vaultPagePath = resolve(routeRoot, '(vault)/vault/+page.svelte')

    expect(existsSync(vaultPagePath)).toBe(true)
    expect(readFileSync(vaultPagePath, 'utf-8')).toContain('VaultGate')
  })

  it('roots users through server-side vault readiness routing', () => {
    const rootServerPath = resolve(routeRoot, '+page.server.ts')

    expect(existsSync(rootServerPath)).toBe(true)
    expect(readFileSync(rootServerPath, 'utf-8')).toContain('getVaultReadiness')
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

  it('guards vault init and unseal submissions while a request is already in flight', () => {
    const vaultComponentsRoot = resolve(routeRoot, '../lib/components/vault')
    const initSource = readFileSync(resolve(vaultComponentsRoot, 'VaultInitForm.svelte'), 'utf-8')
    const unsealSource = readFileSync(
      resolve(vaultComponentsRoot, 'VaultUnsealForm.svelte'),
      'utf-8'
    )

    expect(initSource).toContain('if (isSubmitting) return')
    expect(initSource).toContain('disabled={isSubmitting}')
    expect(unsealSource).toContain('if (isSubmitting) return')
    expect(unsealSource).toContain('disabled={isSubmitting}')
  })
})
