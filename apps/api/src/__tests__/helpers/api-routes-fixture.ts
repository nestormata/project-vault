import { and, eq, sql } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import { auditLogEntries, orgMemberships, users } from '@project-vault/db/schema'

/**
 * Story 68.8 — shared helpers for the apiRoutes integration suites. The fixture extension is
 * imported by string specifier only (never statically), so apps/api's own `tsc` build and Docker
 * image never need its dist; this module types the parts the tests use.
 */
export const API_ROUTES_FIXTURE_PACKAGE = '@project-vault/mock-api-routes-extension'

export type ApiRoutesFixture = {
  setApiRoutesScenario: (
    name:
      | 'default'
      | 'missing-target'
      | 'collision'
      | 'bad-schema'
      | 'above-host'
      | 'never-refused'
      | 'old-pack'
  ) => void
  resetObserved: () => void
  observed: {
    calls: Map<string, number>
    lateNextErrors: string[]
    hooksFactoryCalls: number
    contexts: Array<{ route: string; ctxKeys: string[] }>
  }
}

export async function importApiRoutesFixture(): Promise<ApiRoutesFixture> {
  const specifier: string = API_ROUTES_FIXTURE_PACKAGE
  return (await import(/* @vite-ignore */ specifier)) as ApiRoutesFixture
}

export async function enrollMfa(userId: string): Promise<void> {
  await getDb().update(users).set({ mfaEnrolledAt: new Date() }).where(eq(users.id, userId))
}

export async function expireMfaGracePeriod(orgId: string, userId: string): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx
      .update(orgMemberships)
      .set({ gracePeriodExpiresAt: new Date(Date.now() - 1000) })
      .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
  )
}

export async function auditRowCount(orgId: string, eventType: string): Promise<number> {
  return withOrg(orgId, async (tx) => {
    const rows = await tx
      .select({ id: auditLogEntries.id })
      .from(auditLogEntries)
      .where(and(eq(auditLogEntries.orgId, orgId), eq(auditLogEntries.eventType, eventType)))
    return rows.length
  })
}

export async function fixtureAlertCount(orgId: string): Promise<number> {
  return withOrg(orgId, async (tx) => {
    const rows = await tx.execute(
      sql`select id from security_alerts where org_id = ${orgId} and alert_type = 'cm.fixture_write'`
    )
    return Array.from(rows as unknown as unknown[]).length
  })
}
