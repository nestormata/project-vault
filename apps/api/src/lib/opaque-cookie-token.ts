import { randomBytes, createHmac } from 'node:crypto'
import { env } from '../config/env.js'

/**
 * Shared opaque-cookie-token primitives used by every route that mints a single-use,
 * DB-backed pending-state cookie (`modules/auth/handoff-routes.ts`'s SSO/MFA handoff flow,
 * `modules/extensions/oauth-handoff-routes.ts`'s Story 39.1 extension OAuth handoff flow).
 * Both flows follow the identical opaque-cookie + HMAC-hash pattern, so the primitives live in
 * exactly one place rather than being reimplemented per call site.
 */

export function generateOpaqueId(): string {
  return randomBytes(24).toString('base64url')
}

export function hashCookieValue(raw: string): string {
  return createHmac('sha256', env.SSO_STATE_HMAC_SECRET).update(raw).digest('hex')
}
