import { describe, expect, it, vi } from 'vitest'
import { ApiClientError } from './client.js'
import { getVaultReadiness, initVault, unsealVault } from './vault.js'
import { jsonResponse } from '$lib/test/json-response.js'

describe('vault API helpers', () => {
  it('classifies 200 ready as ready', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ status: 'ready' }))

    await expect(getVaultReadiness(fetchFn)).resolves.toEqual({ state: 'ready' })
  })

  it('classifies uninitialized readiness responses distinctly', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          status: 'unavailable',
          reason: 'uninitialized',
          message: 'Vault not initialized. POST /api/v1/vault/init to initialize.',
        },
        { status: 503 }
      )
    )

    await expect(getVaultReadiness(fetchFn)).resolves.toEqual({
      state: 'uninitialized',
      message: 'Vault not initialized. POST /api/v1/vault/init to initialize.',
    })
  })

  it('classifies legacy uninitialized responses by message without collapsing into sealed', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          status: 'unavailable',
          reason: 'sealed',
          message: 'Vault not initialized. POST /api/v1/vault/init to initialize.',
        },
        { status: 503 }
      )
    )

    await expect(getVaultReadiness(fetchFn)).resolves.toMatchObject({ state: 'uninitialized' })
  })

  it('classifies sealed readiness responses distinctly', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          status: 'unavailable',
          reason: 'sealed',
          message: 'Manual unseal required via POST /api/v1/vault/unseal',
        },
        { status: 503 }
      )
    )

    await expect(getVaultReadiness(fetchFn)).resolves.toEqual({
      state: 'sealed',
      message: 'Manual unseal required via POST /api/v1/vault/unseal',
    })
  })

  it('classifies db and network readiness failures as unavailable', async () => {
    const dbFetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ status: 'unavailable', reason: 'db', retryAfter: 5 }, { status: 503 })
      )
    const networkFetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'))

    await expect(getVaultReadiness(dbFetch)).resolves.toEqual({
      state: 'unavailable',
      message: 'Project Vault is not ready yet. Try again shortly.',
      retryAfter: 5,
    })
    await expect(getVaultReadiness(networkFetch)).resolves.toEqual({
      state: 'unavailable',
      message: 'Project Vault is unavailable. Check the API connection and try again.',
    })
  })

  it('init sends bootstrap token as x-vault-bootstrap-token header and never in body or query', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ initialized: true, keyVersion: 1, kmsType: 'passphrase' }))

    await initVault(
      fetchFn,
      { kmsType: 'passphrase', passphrase: 'correct-horse-battery-staple' },
      'bootstrap-token-value'
    )

    expect(fetchFn).toHaveBeenCalledWith('/api/v1/vault/init', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'x-vault-bootstrap-token': 'bootstrap-token-value',
      },
      body: JSON.stringify({
        kmsType: 'passphrase',
        passphrase: 'correct-horse-battery-staple',
      }),
    })
  })

  it('init and unseal requests include only the selected mode fields', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ initialized: true, keyVersion: 1, kmsType: 'file' }))
      .mockResolvedValueOnce(jsonResponse({ unsealed: true, keyVersion: 1, kmsType: 'envelope' }))

    await initVault(
      fetchFn,
      {
        kmsType: 'file',
        masterKeyPath: '/run/secrets/project-vault/master.key',
        acknowledgeCoLocationRisk: true,
      },
      'bootstrap-token-value'
    )
    await unsealVault(fetchFn, { envelopeKeyPath: '/run/secrets/project-vault/envelope.key' })

    expect(JSON.parse(fetchFn.mock.calls[0]?.[1]?.body as string)).toEqual({
      kmsType: 'file',
      masterKeyPath: '/run/secrets/project-vault/master.key',
      acknowledgeCoLocationRisk: true,
    })
    expect(JSON.parse(fetchFn.mock.calls[1]?.[1]?.body as string)).toEqual({
      envelopeKeyPath: '/run/secrets/project-vault/envelope.key',
    })
  })

  it('maps bootstrap_forbidden to operator copy', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: 'bootstrap_forbidden',
          message: 'Vault bootstrap requires valid bootstrap credentials',
        },
        { status: 403 }
      )
    )

    await expect(
      initVault(fetchFn, { kmsType: 'passphrase', passphrase: 'secret-passphrase' }, '')
    ).rejects.toMatchObject({
      status: 403,
      code: 'bootstrap_forbidden',
      message:
        'This vault is locked to local initialization. Provide the bootstrap token configured on the host, or initialize from the server.',
    } satisfies Partial<ApiClientError>)
  })

  it('surfaces 429 unseal lockout without automatic retry', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { error: 'rate_limit_exceeded', message: 'Too many attempts. Try again later.' },
          { status: 429 }
        )
      )

    await expect(unsealVault(fetchFn, { passphrase: 'wrong-passphrase' })).rejects.toMatchObject({
      status: 429,
      message: 'Too many attempts. Wait a moment and try again.',
    } satisfies Partial<ApiClientError>)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})
