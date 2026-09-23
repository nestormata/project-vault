import { deriveCacheKey, decryptFromCache, encryptForCache } from './cache-crypto.js'
import {
  buildCacheEntry,
  defaultCachePath,
  getEntry,
  isEntryExpired,
  readCacheFile,
  withEntry,
  withoutEntry,
  writeCacheFile,
} from './cache-store.js'
import {
  createFallbackState,
  markLiveRetryAttempted,
  recordNetworkFailure,
  recordSuccess,
  shouldAttemptLiveRetry,
} from './fallback-state.js'
import {
  VaultAgentError,
  VaultCacheExpiredError,
  VaultMultiFieldSecretUnsupportedError,
  VaultUnreachableError,
  VaultUnreachableNonCacheableError,
} from './errors.js'
import { buildInvocationContextHeaders, type SecretRequestContext } from './invocation-context.js'

export type { InvocationLabel, SecretRequestContext } from './invocation-context.js'

export {
  VaultAgentError,
  VaultCacheDecryptionError,
  VaultCacheCorruptedError,
  VaultCacheExpiredError,
  VaultMultiFieldSecretUnsupportedError,
  VaultUnreachableError,
  VaultUnreachableNonCacheableError,
} from './errors.js'

export type VaultAgentConfig = {
  apiKey: string
  baseUrl: string
  projectId: string
  /** Defaults to VAULT_CACHE_PATH env var, then ~/.project-vault/cache.json. */
  cachePath?: string
  /** Defaults to VAULT_FALLBACK_THRESHOLD env var, then 3. */
  fallbackThreshold?: number
}

export type VaultAgent = {
  /**
   * `context` (Story 43.4 AC-3) is optional and additive: when given, the request carries
   * `x-vault-invocation`/`x-vault-target-command` headers the server records (client-asserted) in
   * the reveal's audit entry. Omitting it sends exactly the pre-43.4 request. A value served from
   * the offline cache makes no request at all, so it carries no context and writes no audit entry.
   */
  getSecret: (name: string, context?: SecretRequestContext) => Promise<string>
}

type CredentialValueBody = {
  data: { name: string; value: string; versionNumber: number; cacheable: boolean }
}

const DEFAULT_FALLBACK_THRESHOLD = 3

function readFallbackThreshold(config: VaultAgentConfig): number {
  if (config.fallbackThreshold !== undefined) return config.fallbackThreshold
  const envValue = process.env['VAULT_FALLBACK_THRESHOLD']
  return envValue ? Number(envValue) : DEFAULT_FALLBACK_THRESHOLD
}

export function createVaultAgent(config: VaultAgentConfig): VaultAgent {
  const cachePath = config.cachePath ?? process.env['VAULT_CACHE_PATH'] ?? defaultCachePath()
  const fallbackThreshold = readFallbackThreshold(config)
  const cacheKey = deriveCacheKey(config.apiKey)
  const state = createFallbackState()
  const nonCacheableNames = new Set<string>()
  let accessToken: string | null = null
  let pendingActivationBeacon: { activatedAt: string; threshold: number } | null = null

  async function exchangeToken(): Promise<string> {
    const res = await fetch(`${config.baseUrl}/api/v1/auth/machine-token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}` },
    })
    if (!res.ok) {
      throw new VaultAgentError(
        'token_exchange_failed',
        `Machine token exchange failed with HTTP ${res.status}`
      )
    }
    const body = (await res.json()) as { data: { accessToken: string } }
    return body.data.accessToken
  }

  async function fetchCredentialValue(
    name: string,
    alreadyReauthed: boolean,
    contextHeaders: Record<string, string>
  ): Promise<CredentialValueBody['data']> {
    if (!accessToken) accessToken = await exchangeToken()
    const url = `${config.baseUrl}/api/v1/machine/projects/${config.projectId}/credentials/${encodeURIComponent(name)}/value`
    const res = await fetch(url, {
      headers: { ...contextHeaders, authorization: `Bearer ${accessToken}` },
    })

    if (res.status === 401 && !alreadyReauthed) {
      accessToken = await exchangeToken()
      // Story 43.4 AC-3 — the context must survive the re-auth retry, or the audited request
      // (the retry is the one that succeeds) would lose it.
      return fetchCredentialValue(name, true, contextHeaders)
    }
    if (res.status === 404) {
      throw new VaultAgentError('credential_not_found', `Credential "${name}" was not found`)
    }
    if (res.status === 403) {
      throw new VaultAgentError('insufficient_role', `Access to "${name}" is not permitted`)
    }
    if (res.status === 409) {
      throw new VaultAgentError(
        'ambiguous_credential_name',
        `Multiple credentials named "${name}" exist in this project`
      )
    }
    if (!res.ok) {
      throw new VaultAgentError(
        'vault_request_failed',
        `Vault request failed with HTTP ${res.status}`
      )
    }
    const body = (await res.json()) as CredentialValueBody | { data: { value?: unknown } }
    // Story 13.3 — the machine route now returns a structured `fields[]` shape (no `value`) for a
    // genuinely multi-field secret when queried with no `?field=` (this agent has no field
    // selector). Fail loudly rather than caching/returning `undefined` as if it were the value.
    if (typeof body.data.value !== 'string') {
      throw new VaultMultiFieldSecretUnsupportedError(name)
    }
    return body.data as CredentialValueBody['data']
  }

  /** AC-15 — fire-and-forget; never thrown to the caller of getSecret(), logged at debug only. */
  async function sendPendingActivationBeacon(): Promise<void> {
    if (!pendingActivationBeacon) return
    const payload = pendingActivationBeacon
    try {
      if (!accessToken) accessToken = await exchangeToken()
      await fetch(`${config.baseUrl}/api/v1/machine/cache-activated`, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      pendingActivationBeacon = null
    } catch {
      // Best-effort only — silently dropped, per AC-15.
    }
  }

  function refreshCache(name: string, live: CredentialValueBody['data']): void {
    const cache = readCacheFile(cachePath)
    if (!live.cacheable) {
      nonCacheableNames.add(name)
      if (getEntry(cache, name)) {
        // AC-14: actively delete a stale cached copy from before this credential was marked
        // non-cacheable — never leave a now-forbidden cached copy sitting on disk.
        writeCacheFile(cachePath, withoutEntry(cache, name))
      }
      return
    }
    const encryptedValue = encryptForCache(live.value, cacheKey)
    const entry = buildCacheEntry(encryptedValue, live.versionNumber)
    writeCacheFile(cachePath, withEntry(cache, name, entry))
  }

  function getFromCache(name: string): string {
    const cache = readCacheFile(cachePath)
    const entry = getEntry(cache, name)
    if (!entry) {
      if (nonCacheableNames.has(name)) throw new VaultUnreachableNonCacheableError(name)
      throw new VaultUnreachableError(name)
    }
    // The cache-file's own ttlSeconds/cachedAt fields (AC-12's shape) are a hard bound on how
    // long a secret may be served offline — an entry that has outlived its recorded TTL must stop
    // being servable, not be read indefinitely for the remainder of a long-lived fallback mode.
    if (isEntryExpired(entry)) throw new VaultCacheExpiredError(name)
    // AC-13: never falls back to plaintext — decryptFromCache throws VaultCacheDecryptionError on
    // any auth-tag/parse failure, which propagates as-is to the caller.
    return decryptFromCache(entry.encryptedValue, cacheKey)
  }

  async function getSecret(name: string, context?: SecretRequestContext): Promise<string> {
    const attemptLive = shouldAttemptLiveRetry(state)
    if (!attemptLive) return getFromCache(name)

    // Built BEFORE the try below, whose `TypeError` branch means "network failure → serve from
    // cache" — header construction must never be able to masquerade as a network failure.
    const contextHeaders = buildInvocationContextHeaders(context)

    try {
      const live = await fetchCredentialValue(name, false, contextHeaders)
      const wasInFallback = state.inFallback
      recordSuccess(state)
      refreshCache(name, live)
      if (wasInFallback) await sendPendingActivationBeacon()
      return live.value
    } catch (error) {
      if (error instanceof TypeError) {
        // AC-11: a network-level failure (connection refused, timeout, DNS failure) — never a
        // resolved 4xx/5xx HTTP response, which fetch() would not throw for.
        markLiveRetryAttempted(state)
        recordNetworkFailure(state, fallbackThreshold)
        if (state.inFallback && !pendingActivationBeacon) {
          pendingActivationBeacon = {
            activatedAt: new Date().toISOString(),
            threshold: fallbackThreshold,
          }
        }
        return getFromCache(name)
      }
      throw error
    }
  }

  return { getSecret }
}
