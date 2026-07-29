import type { FastifyReply } from 'fastify'

/** Shared by access-routes.ts (17.1, session-bound) and external-access-routes.ts (17.2,
 *  unauthenticated) — both reveal handlers collapse a revoked/expired/already-viewed share to the
 *  exact same 410 shape, so this is expressed in exactly one place rather than twice. */
export type ShareRevealFailureStatus = 'revoked' | 'expired' | 'already_viewed'

export function shareRevealFailureBody(status: ShareRevealFailureStatus): {
  code: string
  message: string
} {
  if (status === 'revoked') {
    return { code: 'share_revoked', message: 'This share was revoked.' }
  }
  if (status === 'expired') {
    return { code: 'share_expired', message: 'This share has expired.' }
  }
  return { code: 'share_already_viewed', message: 'This share has already been viewed.' }
}

/** AC-17 (17.1)/AC-10 (17.2): token-bearing pages never leak the URL (which carries the raw
 *  token) via Referer. Shared by both access-routes files. */
export function noReferrerHeaders(reply: FastifyReply): void {
  reply.header('Referrer-Policy', 'no-referrer')
}
