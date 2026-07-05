import type { FastifyRequest } from 'fastify'

const BEARER_PREFIX = 'Bearer '

/** Extracts the raw token from an `Authorization: Bearer <token>` header, or null if absent/malformed. */
export function extractBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization
  if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) return null
  const token = header.slice(BEARER_PREFIX.length).trim()
  return token.length > 0 ? token : null
}
