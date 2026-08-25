import { timingSafeEqual } from 'node:crypto'
import { csrfCookieName } from '../modules/auth/tokens.js'

/**
 * Story 25.6 AC5 — the request header the client's postMessage-relay fetch
 * (`apps/web/src/routes/(app)/extensions/panels/[slot]/+page.svelte`) echoes the CSRF cookie
 * value back as. Kept as a named export (not duplicated as a string literal on both sides of the
 * wire) so the two never silently drift — `+page.svelte` imports nothing from this backend
 * package, so its own copy of this exact string is cross-referenced in a comment there instead.
 */
export const CSRF_HEADER_NAME = 'x-csrf-token'

function timingSafeStringsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * Story 25.6 AC1/AC2/AC8 — the double-submit-cookie CSRF check (Task 1 decision, see this
 * story's Dev Notes/Elicitation Log), mirroring `isRejectedBySecFetchSite()`'s own
 * small-exported-directly-testable-function shape so it's trivially reusable by any *future*
 * mutating extension route (AC8) — see `apps/api/src/__tests__/extension-csrf-guard.test.ts` for
 * the structural CI guard that enforces every such route actually calls this.
 *
 * True (=reject) unless the caller echoes the EXACT same value the CSRF cookie itself carries
 * back as the `CSRF_HEADER_NAME` request header. A cross-site attacker page cannot read another
 * origin's cookie value, so it can never produce a matching header — this is layered ON TOP of
 * (never a replacement for) the existing `SameSite=Strict` cookie + CORS allowlist +
 * `Sec-Fetch-Site` check (AC1), closing the one residual gap those layers leave open: a request
 * from a browser old enough to send no `Sec-Fetch-Site` header at all.
 *
 * Deliberately stateless (no server-side token registry/single-use tracking) — verification is
 * pure cookie-vs-header equality, so two concurrent legitimate requests from the same session
 * both succeed (Dev Notes "Testing requirements": a naive single-use-token design would break
 * this), and the check works identically for every request without any per-request bookkeeping.
 */
export function isRejectedByCsrfToken(
  cookies: Record<string, string | undefined> | undefined,
  headerValue: string | string[] | undefined,
  secure = false
): boolean {
  const cookieValue = cookies?.[csrfCookieName(secure)]
  if (!cookieValue) return true
  const header = Array.isArray(headerValue) ? headerValue[0] : headerValue
  if (!header) return true
  return !timingSafeStringsEqual(cookieValue, header)
}
