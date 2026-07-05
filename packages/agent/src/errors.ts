/** Base error class for every error this package throws — always has a stable `.code`. */
export class VaultAgentError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'VaultAgentError'
    this.code = code
  }
}

/**
 * AC-13 — thrown when a cached entry fails AES-GCM auth-tag verification (most commonly: the
 * cache was encrypted under a previous API key, e.g. after rotation, and VAULT_API_KEY was
 * updated without clearing VAULT_CACHE_PATH). Never falls back to returning the raw stored bytes
 * as plaintext, and never silently treats this as "no cache" — both would mask a real
 * cache-is-now-unusable condition.
 */
export class VaultCacheDecryptionError extends VaultAgentError {
  constructor(
    message = 'Failed to decrypt the cached credential — the cache may have been encrypted under a previous API key. Clear VAULT_CACHE_PATH and retry.'
  ) {
    super('cache_decryption_failed', message)
    this.name = 'VaultCacheDecryptionError'
  }
}

/** AC-13 — thrown when the cache file's top-level JSON cannot be parsed (truncated/tampered). */
export class VaultCacheCorruptedError extends VaultAgentError {
  constructor(message = 'The local cache file is corrupted and cannot be read.') {
    super('cache_corrupted', message)
    this.name = 'VaultCacheCorruptedError'
  }
}

/**
 * AC-14 — thrown when the vault is unreachable (fallback mode) and the requested name has no
 * cache entry because it is flagged `cacheable: false` server-side. Distinct from the generic
 * "unreachable, no cache entry" case so the operator knows this secret is specifically flagged
 * high-sensitivity and will never be servable offline, not just "not yet cached".
 */
export class VaultUnreachableNonCacheableError extends VaultAgentError {
  constructor(name: string) {
    super(
      'vault_unreachable_non_cacheable',
      `Vault is unreachable and "${name}" is flagged non-cacheable — it can never be served from the offline cache.`
    )
    this.name = 'VaultUnreachableNonCacheableError'
  }
}

/** AC-11 — vault unreachable and no cache entry exists at all for this name (never cached). */
export class VaultUnreachableError extends VaultAgentError {
  constructor(name: string) {
    super('vault_unreachable', `Vault is unreachable and no cached value exists for "${name}".`)
    this.name = 'VaultUnreachableError'
  }
}

/**
 * Vault unreachable and a cache entry exists for this name, but it has outlived its own recorded
 * `ttlSeconds` (default 24h from the moment it was cached) — distinct from `VaultUnreachableError`
 * so the operator knows a cached value did exist but is now considered too stale to serve,
 * rather than "never cached at all".
 */
export class VaultCacheExpiredError extends VaultAgentError {
  constructor(name: string) {
    super(
      'cache_expired',
      `Vault is unreachable and the cached value for "${name}" has exceeded its cache TTL.`
    )
    this.name = 'VaultCacheExpiredError'
  }
}
