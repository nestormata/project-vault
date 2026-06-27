import { and, count, desc, eq, type SQL } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { securityAlerts } from '@project-vault/db/schema'
import { failedAuthThresholdPayloadSchema, type SecurityAlertsQuery } from './schema.js'

function deliveryStatusFor(
  status: string
): 'pending_notification_channel' | 'delivered' | 'dismissed' {
  if (status === 'PENDING_DELIVERY') return 'pending_notification_channel'
  if (status === 'delivered') return 'delivered'
  return 'dismissed'
}

export async function listSecurityAlerts(orgId: string, query: SecurityAlertsQuery) {
  return withOrg(orgId, async (tx) => {
    const filters: SQL[] = []
    if (query.status !== 'all') filters.push(eq(securityAlerts.status, query.status))
    if (query.severity) filters.push(eq(securityAlerts.severity, query.severity))
    const where = filters.length ? and(...filters) : undefined

    const [totalRow] = await tx.select({ total: count() }).from(securityAlerts).where(where)
    const total = totalRow?.total ?? 0

    const rows = await tx
      .select()
      .from(securityAlerts)
      .where(where)
      .orderBy(desc(securityAlerts.createdAt))
      .limit(query.limit)
      .offset((query.page - 1) * query.limit)

    const items = rows.flatMap((row) => {
      const payload = failedAuthThresholdPayloadSchema.safeParse(row.payload)
      if (!payload.success) {
        process.stderr.write(
          `[org.security_alerts.invalid_payload] alertId=${row.id} ${payload.error.message}\n`
        )
        return []
      }
      return [
        {
          id: row.id,
          alertType: row.alertType,
          severity: row.severity as 'info' | 'warning' | 'critical',
          status: row.status as 'PENDING_DELIVERY' | 'delivered' | 'dismissed',
          payload: payload.data,
          deliveryStatus: deliveryStatusFor(row.status),
          createdAt: row.createdAt.toISOString(),
        },
      ]
    })

    return {
      items,
      total,
      page: query.page,
      limit: query.limit,
      hasNext: query.page * query.limit < total,
    }
  })
}
