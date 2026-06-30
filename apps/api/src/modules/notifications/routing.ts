import { and, eq } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { orgMemberships, orgNotificationRouting } from '@project-vault/db/schema'
import {
  NOTIFICATION_ALERT_TYPES,
  DEFAULT_ROUTING_ROLE,
  type RoutingRole,
} from '@project-vault/shared'
import type { z } from 'zod/v4'
import type { RoutingItemSchema } from './schema.js'

type RoutingInput = z.infer<typeof RoutingItemSchema>

export type RoutingOutput = {
  alertType: string
  routeTo: RoutingRole
}

export class SecurityAlertRoutingError extends Error {
  readonly statusCode = 422
  readonly code = 'SECURITY_ALERT_ROUTING_RESTRICTED'

  constructor(alertType: string) {
    super(
      `Security alert type '${alertType}' cannot be routed to all members. Use 'owner' or 'admin'.`
    )
    this.name = 'SecurityAlertRoutingError'
  }
}

const SECURITY_ALERT_TYPE_PREFIX = 'security.'

export async function getOrgRouting(orgId: string, tx: Tx): Promise<RoutingOutput[]> {
  const stored = await tx
    .select()
    .from(orgNotificationRouting)
    .where(eq(orgNotificationRouting.orgId, orgId))

  const storedMap = new Map(stored.map((r) => [r.alertType, r.routeTo as RoutingRole]))

  return NOTIFICATION_ALERT_TYPES.map((alertType) => ({
    alertType,
    routeTo: storedMap.get(alertType) ?? DEFAULT_ROUTING_ROLE,
  }))
}

export async function putOrgRouting(
  orgId: string,
  items: RoutingInput[],
  tx: Tx
): Promise<RoutingOutput[]> {
  for (const item of items) {
    if (item.alertType.startsWith(SECURITY_ALERT_TYPE_PREFIX) && item.routeTo === 'member') {
      throw new SecurityAlertRoutingError(item.alertType)
    }
  }

  await tx.delete(orgNotificationRouting).where(eq(orgNotificationRouting.orgId, orgId))

  if (items.length > 0) {
    await tx.insert(orgNotificationRouting).values(
      items.map((item) => ({
        orgId,
        alertType: item.alertType,
        routeTo: item.routeTo,
      }))
    )
  }

  return getOrgRouting(orgId, tx)
}

export async function resolveRoutingRecipients(
  orgId: string,
  alertType: string,
  tx: Tx
): Promise<string[]> {
  const routing = await tx
    .select({ routeTo: orgNotificationRouting.routeTo })
    .from(orgNotificationRouting)
    .where(
      and(eq(orgNotificationRouting.orgId, orgId), eq(orgNotificationRouting.alertType, alertType))
    )
    .limit(1)

  const targetRole: RoutingRole = (routing[0]?.routeTo as RoutingRole) ?? DEFAULT_ROUTING_ROLE
  const members = await getMembersWithRole(orgId, targetRole, tx)

  if (members.length === 0 && targetRole !== 'owner') {
    process.stdout.write(
      `${JSON.stringify({
        eventType: 'notification.routing_fallback',
        orgId,
        alertType,
        targetRole,
        fallbackRole: 'owner',
      })}\n`
    )
    const owners = await getMembersWithRole(orgId, 'owner', tx)
    if (owners.length === 0) {
      process.stderr.write(
        `${JSON.stringify({
          eventType: 'notification.routing_no_recipients',
          orgId,
          alertType,
          message: 'No owner or admin members found; no notifications will be sent',
        })}\n`
      )
      return []
    }
    return owners
  }

  return members
}

async function getMembersWithRole(orgId: string, role: RoutingRole, tx: Tx): Promise<string[]> {
  const conditions = [eq(orgMemberships.orgId, orgId), eq(orgMemberships.status, 'active')]
  if (role !== 'member') {
    conditions.push(eq(orgMemberships.role, role))
  }

  const rows = await tx
    .select({ userId: orgMemberships.userId })
    .from(orgMemberships)
    .where(and(...conditions))

  return rows.map((r) => r.userId)
}
