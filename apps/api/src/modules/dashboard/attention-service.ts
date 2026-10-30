import { and, asc, eq, exists, gt, isNotNull, isNull, lte, sql, type SQL } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import {
  certRecords,
  credentials,
  credentialShares,
  projectInvitations,
  projectMemberships,
  projects,
} from '@project-vault/db/schema'
import {
  ATTENTION_CERTIFICATE_HORIZON_DAYS,
  ATTENTION_ITEMS_PER_KIND,
  ATTENTION_SHARE_HORIZON_DAYS,
  type AttentionCounts,
  type AttentionItem,
  type DashboardAttention,
} from '@project-vault/shared'
import { effectiveSharerSql } from '../credential-shares/service.js'

/**
 * Story 72-12 (P8): the dashboard "needs attention" list. Three bounded queries, merged in memory.
 * Every query reuses the visibility rule of the list route it mirrors (the shares index, the
 * project certificates list, the project invitations list), so an item is never shown to a caller
 * who could not read the same row there. The database `now()` is the only clock.
 */

export type AttentionViewer = {
  orgId: string
  userId: string
  /** Org owner or admin: sees every project. */
  isAdmin: boolean
  /** Org viewer: reads no cross-project attention data at all (an empty list, never a 403). */
  isViewer: boolean
}

export const EMPTY_ATTENTION: DashboardAttention = {
  items: [],
  counts: { expiringShares: 0, expiringCertificates: 0, pendingInvitations: 0 },
}

const horizon = (days: number) => sql`now() + make_interval(days => ${days})`

/** A project the caller may see: not deleted, not archived, and (non-admin) a member of it. */
function visibleProject(viewer: AttentionViewer): SQL | undefined {
  return and(
    isNull(projects.deletedAt),
    isNull(projects.archivedAt),
    viewer.isAdmin
      ? undefined
      : exists(
          sql`(SELECT 1 FROM ${projectMemberships} WHERE ${projectMemberships.projectId} = ${projects.id} AND ${projectMemberships.userId} = ${viewer.userId})`
        )
  )
}

const sharesWhere = (viewer: AttentionViewer) =>
  and(
    eq(credentialShares.orgId, viewer.orgId),
    visibleProject(viewer),
    viewer.isAdmin ? undefined : sql`${effectiveSharerSql} = ${viewer.userId}`,
    // A live share only: still active, not locked, not yet expired, expiring within the horizon.
    eq(credentialShares.status, 'active'),
    isNull(credentialShares.lockedAt),
    gt(credentialShares.expiresAt, sql`now()`),
    lte(credentialShares.expiresAt, horizon(ATTENTION_SHARE_HORIZON_DAYS))
  )

const certificatesWhere = (viewer: AttentionViewer) =>
  and(
    eq(certRecords.orgId, viewer.orgId),
    visibleProject(viewer),
    isNotNull(certRecords.expiresAt),
    // Already-expired certificates stay: the most urgent item (A5).
    lte(certRecords.expiresAt, horizon(ATTENTION_CERTIFICATE_HORIZON_DAYS))
  )

const invitationsWhere = (viewer: AttentionViewer) =>
  and(
    eq(projectInvitations.orgId, viewer.orgId),
    visibleProject(viewer),
    isNull(projectInvitations.acceptedAt),
    isNull(projectInvitations.revokedAt),
    gt(projectInvitations.expiresAt, sql`now()`)
  )

/**
 * `count(*) over ()` is evaluated before LIMIT, so every returned row carries the true total for
 * the same WHERE (one query per kind, no second count query to drift from the first). An empty
 * page means the total is zero.
 */
const totalSql = sql<number>`count(*) over ()`

const totalOf = (rows: ReadonlyArray<{ total: number }>) => Number(rows[0]?.total ?? 0)

async function expiringShares(tx: Tx, viewer: AttentionViewer) {
  const rows = await tx
    .select({
      total: totalSql,
      id: credentialShares.id,
      dueAt: credentialShares.expiresAt,
      projectId: projects.id,
      projectName: projects.name,
      credentialId: credentials.id,
      credentialName: credentials.name,
      recipientEmail: credentialShares.recipientEmail,
    })
    .from(credentialShares)
    .innerJoin(credentials, eq(credentialShares.credentialId, credentials.id))
    .innerJoin(projects, eq(credentials.projectId, projects.id))
    .where(sharesWhere(viewer))
    .orderBy(asc(credentialShares.expiresAt), asc(credentialShares.id))
    .limit(ATTENTION_ITEMS_PER_KIND)
  const items: AttentionItem[] = rows.map((row) => ({
    kind: 'expiring_share',
    id: row.id,
    dueAt: row.dueAt.toISOString(),
    projectId: row.projectId,
    projectName: row.projectName,
    credentialId: row.credentialId,
    credentialName: row.credentialName,
    recipientEmail: row.recipientEmail,
  }))
  return { items, total: totalOf(rows) }
}

async function expiringCertificates(tx: Tx, viewer: AttentionViewer) {
  const rows = await tx
    .select({
      total: totalSql,
      id: certRecords.id,
      dueAt: certRecords.expiresAt,
      projectId: projects.id,
      projectName: projects.name,
      domain: certRecords.domain,
      expired: sql<boolean>`${certRecords.expiresAt} <= now()`,
    })
    .from(certRecords)
    .innerJoin(projects, eq(certRecords.projectId, projects.id))
    .where(certificatesWhere(viewer))
    .orderBy(asc(certRecords.expiresAt), asc(certRecords.id))
    .limit(ATTENTION_ITEMS_PER_KIND)
  const items: AttentionItem[] = rows.flatMap((row) =>
    row.dueAt
      ? [
          {
            kind: 'expiring_certificate' as const,
            id: row.id,
            dueAt: row.dueAt.toISOString(),
            projectId: row.projectId,
            projectName: row.projectName,
            domain: row.domain,
            expired: row.expired,
          },
        ]
      : []
  )
  return { items, total: totalOf(rows) }
}

async function pendingInvitations(tx: Tx, viewer: AttentionViewer) {
  const rows = await tx
    .select({
      total: totalSql,
      id: projectInvitations.id,
      dueAt: projectInvitations.expiresAt,
      projectId: projects.id,
      projectName: projects.name,
      email: projectInvitations.email,
      roleToAssign: projectInvitations.roleToAssign,
    })
    .from(projectInvitations)
    .innerJoin(projects, eq(projectInvitations.projectId, projects.id))
    .where(invitationsWhere(viewer))
    .orderBy(asc(projectInvitations.expiresAt), asc(projectInvitations.id))
    .limit(ATTENTION_ITEMS_PER_KIND)
  const items: AttentionItem[] = rows.map((row) => ({
    kind: 'pending_invitation',
    id: row.id,
    dueAt: row.dueAt.toISOString(),
    projectId: row.projectId,
    projectName: row.projectName,
    email: row.email,
    roleToAssign: row.roleToAssign as 'admin' | 'member' | 'viewer',
  }))
  return { items, total: totalOf(rows) }
}

/** Flat list ordered by due instant, ties by id (string order, stable across kinds). */
export function mergeAttention(
  parts: ReadonlyArray<readonly AttentionItem[]>,
  counts: AttentionCounts
): DashboardAttention {
  const items = parts
    .flat()
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.id.localeCompare(b.id))
  return { items, counts }
}

export async function getDashboardAttention(
  tx: Tx,
  viewer: AttentionViewer
): Promise<DashboardAttention> {
  if (viewer.isViewer) return EMPTY_ATTENTION
  const [shares, certificates, invitations] = await Promise.all([
    expiringShares(tx, viewer),
    expiringCertificates(tx, viewer),
    viewer.isAdmin ? pendingInvitations(tx, viewer) : { items: [], total: 0 },
  ])
  return mergeAttention([shares.items, certificates.items, invitations.items], {
    expiringShares: shares.total,
    expiringCertificates: certificates.total,
    pendingInvitations: invitations.total,
  })
}
