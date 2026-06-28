import { ApiClientError, apiFetch, type ApiFailure } from './client.js'

export type VaultReadiness =
  | { state: 'ready' }
  | { state: 'uninitialized'; message: string }
  | { state: 'sealed'; message: string }
  | { state: 'unavailable'; message: string; retryAfter?: number }

export type VaultInitRequest =
  | { kmsType: 'passphrase'; passphrase: string }
  | { kmsType: 'envelope'; envelopeKeyPath: string; acknowledgeSplitKeyModel: true }
  | { kmsType: 'file'; masterKeyPath: string; acknowledgeCoLocationRisk: true }

export type VaultUnsealRequest =
  | { passphrase: string }
  | { envelopeKeyPath: string }
  | { masterKeyPath: string }

export type VaultInitResponse = {
  initialized: true
  keyVersion: number
  kmsType: string
}

export type VaultUnsealResponse = {
  unsealed: true
  keyVersion: number
  kmsType: string
}

type ReadyBody = {
  status: 'ready' | 'unavailable'
  reason?: string
  message?: string
  retryAfter?: number
}

function isUninitializedReadyBody(body: ReadyBody | null) {
  return (
    body?.reason === 'uninitialized' ||
    body?.message?.toLowerCase().includes('not initialized') === true
  )
}

function uninitializedReadiness(body: ReadyBody): VaultReadiness {
  return {
    state: 'uninitialized',
    message: body.message ?? 'Vault not initialized.',
  }
}

function sealedReadiness(body: ReadyBody): VaultReadiness {
  return {
    state: 'sealed',
    message: body.message ?? 'Manual unseal is required.',
  }
}

function unavailableReadiness(body: ReadyBody | null): VaultReadiness {
  return {
    state: 'unavailable',
    message: 'Project Vault is not ready yet. Try again shortly.',
    retryAfter: body?.retryAfter,
  }
}

function readinessFromBody(body: ReadyBody | null): VaultReadiness {
  if (!body) return unavailableReadiness(body)
  if (body.status === 'ready') return { state: 'ready' }
  if (isUninitializedReadyBody(body)) {
    return uninitializedReadiness(body)
  }
  if (body.reason === 'sealed') return sealedReadiness(body)
  return unavailableReadiness(body)
}

export async function getVaultReadiness(fetchFn: typeof fetch): Promise<VaultReadiness> {
  let response: Response
  try {
    response = await fetchFn('/ready', { credentials: 'include' })
  } catch {
    return {
      state: 'unavailable',
      message: 'Project Vault is unavailable. Check the API connection and try again.',
    }
  }

  const body = (await response.json().catch(() => null)) as ReadyBody | null
  return readinessFromBody(response.ok ? { status: 'ready' } : body)
}

export async function initVault(
  fetchFn: typeof fetch,
  request: VaultInitRequest,
  bootstrapToken: string
) {
  try {
    return await apiFetch<VaultInitResponse>(fetchFn, '/api/v1/vault/init', {
      method: 'POST',
      headers: {
        'x-vault-bootstrap-token': bootstrapToken,
      },
      body: JSON.stringify(request),
    })
  } catch (error) {
    if (error instanceof ApiClientError && error.code === 'bootstrap_forbidden') {
      throw new ApiClientError(
        error.status,
        error.body,
        'This vault is locked to local initialization. Provide the bootstrap token configured on the host, or initialize from the server.'
      )
    }
    throw error
  }
}

export async function unsealVault(fetchFn: typeof fetch, request: VaultUnsealRequest) {
  try {
    return await apiFetch<VaultUnsealResponse>(fetchFn, '/api/v1/vault/unseal', {
      method: 'POST',
      body: JSON.stringify(request),
    })
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 429) {
      throw new ApiClientError(
        error.status,
        error.body as ApiFailure | null,
        'Too many attempts. Wait a moment and try again.'
      )
    }
    throw error
  }
}
