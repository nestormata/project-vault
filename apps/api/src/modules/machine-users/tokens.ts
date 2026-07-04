import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { env } from '../../config/env.js'

const API_KEY_PREFIX = 'pk_'

/**
 * Generates a plaintext machine-user API key: `pk_` + base64url(randomBytes(32)) — 256-bit
 * entropy, 46 chars total. See story D2: architecture-canonical format, not epics.md's literal
 * `pvk_` + base62 spec. Mirrors the exact `randomBytes(32).toString('base64url')` pattern
 * `auth/tokens.ts`'s `generateRefreshToken()` already uses.
 */
export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`
}

/**
 * Hashes a plaintext API key with HMAC-SHA256 using a dedicated per-purpose secret. See story
 * D1: architecture.md mandates HMAC-SHA256 (not BLAKE2b) for API key hashing — this mirrors
 * `auth/tokens.ts`'s `hashRefreshToken()` exactly.
 */
export function hashApiKey(plaintext: string): string {
  return createHmac('sha256', env.API_KEY_HMAC_SECRET).update(plaintext).digest('hex')
}

/** Constant-time comparison of a stored key hash against a freshly-hashed candidate plaintext. */
export function apiKeysMatch(storedHash: string, plaintext: string): boolean {
  const computed = hashApiKey(plaintext)
  if (!/^[0-9a-f]{64}$/i.test(storedHash)) return false
  if (storedHash.length !== computed.length) return false
  return timingSafeEqual(Buffer.from(storedHash, 'hex'), Buffer.from(computed, 'hex'))
}
