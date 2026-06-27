import type { FastifyReply } from 'fastify/types/reply.js'
import type { FastifyRequest } from 'fastify/types/request.js'
import type { FastifyApp } from './fastify-app.js'

export const ACCESS_TOKEN_MISSING_RESPONSE = {
  code: 'access_token_missing',
  message: 'Access token is missing',
}

export function validationError(
  error: { issues: { path: PropertyKey[]; message: string }[] },
  fallbackPath: string
) {
  const details = new Map<string, string[]>()
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? fallbackPath)
    details.set(key, [...(details.get(key) ?? []), issue.message])
  }
  return {
    code: 'validation_error',
    message: 'Request validation failed',
    details: Object.fromEntries(details),
  }
}

export function authPreHandler(fastify: FastifyApp) {
  return (fastify as unknown as { authenticate: unknown }).authenticate
}

export function requireAuthContext(req: FastifyRequest, reply: FastifyReply) {
  const authContext = req.authContext
  if (!authContext) {
    reply.status(401).send(ACCESS_TOKEN_MISSING_RESPONSE)
    return null
  }
  return authContext
}
