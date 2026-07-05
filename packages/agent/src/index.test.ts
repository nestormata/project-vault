import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createVaultAgent, VaultCacheDecryptionError } from './index.js'
import { readCacheFile } from './cache-store.js'

const BASE_URL = 'https://vault.example.test'
const PROJECT_ID = 'project-abc'
const API_KEY = 'pk_test-api-key-aaaaaaaaaaaaaaaaaaaa'
const TOKEN_URL = `${BASE_URL}/api/v1/auth/machine-token`
const NETWORK_FAILURE_MESSAGE = 'fetch failed'
const FIRST_ACCESS_TOKEN = 'jwt-1'
const CACHED_OFFLINE_VALUE = 'cached-offline-value'

let dir: string
let cachePath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vault-agent-index-test-'))
  cachePath = join(dir, 'cache.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function credentialUrl(name: string): string {
  return `${BASE_URL}/api/v1/machine/projects/${PROJECT_ID}/credentials/${encodeURIComponent(name)}/value`
}

describe('createVaultAgent().getSecret (AC-10)', () => {
  it('exchanges a token, fetches the value live, and returns it', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === TOKEN_URL) return jsonResponse(200, { data: { accessToken: FIRST_ACCESS_TOKEN } })
      if (url === credentialUrl('DATABASE_URL')) {
        return jsonResponse(200, {
          data: { name: 'DATABASE_URL', value: 'postgres://v1', versionNumber: 1, cacheable: true },
        })
      }
      throw new Error(`unexpected url ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const agent = createVaultAgent({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      projectId: PROJECT_ID,
      cachePath,
    })
    const value = await agent.getSecret('DATABASE_URL')

    expect(value).toBe('postgres://v1')
    expect(fetchMock).toHaveBeenCalledWith(TOKEN_URL, expect.objectContaining({ method: 'POST' }))
  })

  it('opportunistically writes a cache entry after a successful live fetch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === TOKEN_URL)
          return jsonResponse(200, { data: { accessToken: FIRST_ACCESS_TOKEN } })
        return jsonResponse(200, {
          data: { name: 'X', value: 'cached-value', versionNumber: 2, cacheable: true },
        })
      })
    )

    const agent = createVaultAgent({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      projectId: PROJECT_ID,
      cachePath,
    })
    await agent.getSecret('X')

    const cache = readCacheFile(cachePath)
    expect(cache['X']?.versionNumber).toBe(2)
  })

  it('throws a typed VaultAgentError for a 404 credential_not_found response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === TOKEN_URL)
          return jsonResponse(200, { data: { accessToken: FIRST_ACCESS_TOKEN } })
        return jsonResponse(404, { code: 'credential_not_found', message: 'not found' })
      })
    )

    const agent = createVaultAgent({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      projectId: PROJECT_ID,
      cachePath,
    })
    await expect(agent.getSecret('NOPE')).rejects.toMatchObject({
      code: 'credential_not_found',
    })
  })

  it('re-exchanges the token once on a 401 and retries', async () => {
    let tokenCalls = 0
    let valueCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === TOKEN_URL) {
          tokenCalls += 1
          return jsonResponse(200, { data: { accessToken: `jwt-${tokenCalls}` } })
        }
        valueCalls += 1
        if (valueCalls === 1) return jsonResponse(401, { code: 'invalid_machine_token' })
        return jsonResponse(200, {
          data: { name: 'Y', value: 'value-after-reauth', versionNumber: 1, cacheable: true },
        })
      })
    )

    const agent = createVaultAgent({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      projectId: PROJECT_ID,
      cachePath,
    })
    const value = await agent.getSecret('Y')

    expect(value).toBe('value-after-reauth')
    expect(tokenCalls).toBe(2)
  })
})

describe('createVaultAgent().getSecret — offline fallback (AC-11/AC-12/AC-13)', () => {
  it('activates fallback mode after 3 consecutive network failures and serves from cache', async () => {
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === TOKEN_URL)
          return jsonResponse(200, { data: { accessToken: FIRST_ACCESS_TOKEN } })
        call += 1
        if (call <= 3) throw new TypeError(NETWORK_FAILURE_MESSAGE)
        return jsonResponse(200, {
          data: { name: 'Z', value: 'should-not-be-used', versionNumber: 1, cacheable: true },
        })
      })
    )

    const agent = createVaultAgent({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      projectId: PROJECT_ID,
      cachePath,
    })

    // Seed the cache as if a prior successful call had cached this name.
    const seedAgent = createVaultAgent({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      projectId: PROJECT_ID,
      cachePath,
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === TOKEN_URL)
          return jsonResponse(200, { data: { accessToken: FIRST_ACCESS_TOKEN } })
        return jsonResponse(200, {
          data: { name: 'Z', value: CACHED_OFFLINE_VALUE, versionNumber: 1, cacheable: true },
        })
      })
    )
    await seedAgent.getSecret('Z')

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === TOKEN_URL)
          return jsonResponse(200, { data: { accessToken: FIRST_ACCESS_TOKEN } })
        call += 1
        throw new TypeError(NETWORK_FAILURE_MESSAGE)
      })
    )

    await expect(agent.getSecret('Z')).resolves.toBe(CACHED_OFFLINE_VALUE)
    await expect(agent.getSecret('Z')).resolves.toBe(CACHED_OFFLINE_VALUE)
    const value = await agent.getSecret('Z')
    expect(value).toBe(CACHED_OFFLINE_VALUE)
  })

  it('throws VaultUnreachableError when offline with no cache entry for the name', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === TOKEN_URL)
          return jsonResponse(200, { data: { accessToken: FIRST_ACCESS_TOKEN } })
        throw new TypeError(NETWORK_FAILURE_MESSAGE)
      })
    )

    const agent = createVaultAgent({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      projectId: PROJECT_ID,
      cachePath,
      fallbackThreshold: 1,
    })

    await expect(agent.getSecret('NEVER_CACHED')).rejects.toMatchObject({
      code: 'vault_unreachable',
    })
  })

  it('throws VaultCacheDecryptionError (never plaintext) when the cache was encrypted under a different key', async () => {
    const seedAgent = createVaultAgent({
      apiKey: 'pk_original-key-aaaaaaaaaaaaaaaaaaa',
      baseUrl: BASE_URL,
      projectId: PROJECT_ID,
      cachePath,
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === TOKEN_URL)
          return jsonResponse(200, { data: { accessToken: FIRST_ACCESS_TOKEN } })
        return jsonResponse(200, {
          data: { name: 'ROTATED', value: 'v1', versionNumber: 1, cacheable: true },
        })
      })
    )
    await seedAgent.getSecret('ROTATED')

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === TOKEN_URL)
          return jsonResponse(200, { data: { accessToken: FIRST_ACCESS_TOKEN } })
        throw new TypeError(NETWORK_FAILURE_MESSAGE)
      })
    )
    const rotatedAgent = createVaultAgent({
      apiKey: 'pk_rotated-key-bbbbbbbbbbbbbbbbbbbb',
      baseUrl: BASE_URL,
      projectId: PROJECT_ID,
      cachePath,
      fallbackThreshold: 1,
    })

    await expect(rotatedAgent.getSecret('ROTATED')).rejects.toBeInstanceOf(
      VaultCacheDecryptionError
    )
  })
})

describe('createVaultAgent().getSecret — non-cacheable exclusion (AC-14)', () => {
  it('does not write a non-cacheable credential to the cache', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === TOKEN_URL)
          return jsonResponse(200, { data: { accessToken: FIRST_ACCESS_TOKEN } })
        return jsonResponse(200, {
          data: { name: 'HIGH_SENSITIVITY', value: 'v1', versionNumber: 1, cacheable: false },
        })
      })
    )

    const agent = createVaultAgent({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      projectId: PROJECT_ID,
      cachePath,
    })
    await agent.getSecret('HIGH_SENSITIVITY')

    const cache = readCacheFile(cachePath)
    expect(cache['HIGH_SENSITIVITY']).toBeUndefined()
  })

  it('deletes a stale cached entry once a credential is live-read as non-cacheable', async () => {
    const seedAgent = createVaultAgent({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      projectId: PROJECT_ID,
      cachePath,
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === TOKEN_URL)
          return jsonResponse(200, { data: { accessToken: FIRST_ACCESS_TOKEN } })
        return jsonResponse(200, {
          data: { name: 'FLIPPED', value: 'v1', versionNumber: 1, cacheable: true },
        })
      })
    )
    await seedAgent.getSecret('FLIPPED')
    expect(readCacheFile(cachePath)['FLIPPED']).toBeDefined()

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === TOKEN_URL)
          return jsonResponse(200, { data: { accessToken: FIRST_ACCESS_TOKEN } })
        return jsonResponse(200, {
          data: { name: 'FLIPPED', value: 'v2', versionNumber: 2, cacheable: false },
        })
      })
    )
    await seedAgent.getSecret('FLIPPED')

    expect(readCacheFile(cachePath)['FLIPPED']).toBeUndefined()
  })

  it('throws VaultUnreachableNonCacheableError when offline for a name known to be non-cacheable', async () => {
    const agent = createVaultAgent({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      projectId: PROJECT_ID,
      cachePath,
      fallbackThreshold: 1,
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === TOKEN_URL)
          return jsonResponse(200, { data: { accessToken: FIRST_ACCESS_TOKEN } })
        return jsonResponse(200, {
          data: { name: 'NEVER_CACHEABLE', value: 'v1', versionNumber: 1, cacheable: false },
        })
      })
    )
    await agent.getSecret('NEVER_CACHEABLE')

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === TOKEN_URL)
          return jsonResponse(200, { data: { accessToken: FIRST_ACCESS_TOKEN } })
        throw new TypeError(NETWORK_FAILURE_MESSAGE)
      })
    )

    await expect(agent.getSecret('NEVER_CACHEABLE')).rejects.toMatchObject({
      code: 'vault_unreachable_non_cacheable',
    })
  })
})
