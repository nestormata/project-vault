import type { preHandlerHookHandler } from 'fastify'
import { requireMfaEnrollment } from '../modules/auth/mfa-enforcement.js'
import { requireOrgRole, type OrgRole } from '../plugins/require-org-role.js'

export const secureRoutes = new Set<string>()
// Story 1.11 implements full SecureRoute factory
// This Set is imported by route-audit.test.ts to verify all routes are secured

export type SecureRouteOptions = {
  requireAuth?: boolean
  requireMfa?: boolean
  requireOrgRole?: OrgRole[]
}

export function buildSecurePreHandlers(
  fastify: { authenticate?: unknown },
  options: SecureRouteOptions
): preHandlerHookHandler[] {
  const chain: preHandlerHookHandler[] = []
  if (options.requireAuth !== false) {
    if (typeof fastify.authenticate !== 'function') {
      throw new Error(
        'buildSecurePreHandlers: requireAuth is set but fastify.authenticate is not registered'
      )
    }
    chain.push(fastify.authenticate as preHandlerHookHandler)
  }
  if (options.requireOrgRole?.length) chain.push(requireOrgRole(...options.requireOrgRole))
  if (options.requireMfa) chain.push(requireMfaEnrollment())
  return chain
}
