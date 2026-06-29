import { and, eq } from 'drizzle-orm'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { parseBody } from '../../lib/route-helpers.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { writeHumanAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import { userOnboarding } from '@project-vault/db/schema'
import {
  CompleteOnboardingBodySchema,
  CompleteOnboardingResponseSchema,
  OnboardingStatusResponseSchema,
} from './schema.js'

const ONBOARDING_ALREADY_COMPLETED = {
  code: 'onboarding_already_completed',
  message: 'Onboarding has already been completed for this user in this org.',
} as const

async function findOnboardingRow(secureCtx: SecureRouteContext) {
  const rows = await secureCtx.tx
    .select({ completedAt: userOnboarding.completedAt })
    .from(userOnboarding)
    .where(
      and(
        eq(userOnboarding.userId, secureCtx.auth.userId),
        eq(userOnboarding.orgId, secureCtx.auth.orgId)
      )
    )
    .limit(1)
  return rows[0] ?? null
}

export async function onboardingRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'GET',
    url: '/me/onboarding',
    schema: {
      response: {
        200: OnboardingStatusResponseSchema,
        401: ApiErrorSchema,
      },
    },
    security: {
      requireMfa: false,
      writeAuditEvent: false,
    },
    handler: async (ctx) => {
      const secureCtx = ctx as SecureRouteContext
      const row = await findOnboardingRow(secureCtx)
      if (!row) return { completed: false }
      return { completed: true, completedAt: row.completedAt.toISOString() }
    },
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/me/onboarding',
    schema: {
      response: {
        200: CompleteOnboardingResponseSchema,
        401: ApiErrorSchema,
        409: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      requireMfa: false,
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const parsed = parseBody(CompleteOnboardingBodySchema, req, reply)
      if (!parsed.success) return reply

      const secureCtx = ctx as SecureRouteContext
      const existing = await findOnboardingRow(secureCtx)
      if (existing) return reply.status(409).send(ONBOARDING_ALREADY_COMPLETED)

      const [inserted] = await secureCtx.tx
        .insert(userOnboarding)
        .values({
          userId: secureCtx.auth.userId,
          orgId: secureCtx.auth.orgId,
        })
        .returning({ completedAt: userOnboarding.completedAt })

      if (!inserted) throw new Error('Onboarding insert returned no row')

      const completedAt = inserted.completedAt.toISOString()

      // NOTE: No credential-existence check — wizard is a UX gate, not a security gate.
      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'onboarding.completed',
        resourceId: secureCtx.auth.userId,
        resourceType: 'user_onboarding',
        payload: {
          orgId: secureCtx.auth.orgId,
          completedAt,
        },
        request: req,
      })

      return {
        completed: true as const,
        completedAt,
      }
    },
  })
}
