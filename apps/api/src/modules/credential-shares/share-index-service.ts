import { and, desc, eq, exists, isNull, sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import {
  credentials,
  credentialShares,
  projectMemberships,
  projects,
} from '@project-vault/db/schema'
import type { ShareDisplayStatus } from '@project-vault/shared'
import { displayStatusPredicate } from './display-status-sql.js'
import { effectiveSharerSql, type CredentialShareRow } from './service.js'

export type ListSharesIndexParams = {
  orgId: string
  viewerUserId: string
  /** Org admin/owner: every share of the org. A member: only shares they are the effective sharer of. */
  viewerIsAdmin: boolean
  status?: CredentialShareRow['status']
  displayStatus?: ShareDisplayStatus
  limit: number
  offset: number
}

export type SharesIndexRow = {
  share: CredentialShareRow
  credentialName: string
  projectId: string
  projectName: string
}

/**
 * One WHERE clause for the page and the count. A non-admin only gets rows whose project they hold a
 * `project_memberships` row for: the same rule `callerCanSeeProject` applies (org owner/admin see
 * every project), expressed in SQL so `total` and paging stay exact and a credential name in a
 * project the member cannot see is never read.
 */
function indexWhere(params: ListSharesIndexParams) {
  return and(
    eq(credentialShares.orgId, params.orgId),
    // A soft-deleted project answers 404 everywhere (72-9); its shares are not listed either.
    isNull(projects.deletedAt),
    params.viewerIsAdmin ? undefined : sql`${effectiveSharerSql} = ${params.viewerUserId}`,
    params.viewerIsAdmin
      ? undefined
      : exists(
          sql`(SELECT 1 FROM ${projectMemberships} WHERE ${projectMemberships.projectId} = ${projects.id} AND ${projectMemberships.userId} = ${params.viewerUserId})`
        ),
    params.status ? eq(credentialShares.status, params.status) : undefined,
    params.displayStatus ? displayStatusPredicate(params.displayStatus) : undefined
  )
}

function indexFrom(tx: Tx) {
  return tx
    .select({
      share: credentialShares,
      credentialName: credentials.name,
      projectId: projects.id,
      projectName: projects.name,
    })
    .from(credentialShares)
    .innerJoin(credentials, eq(credentialShares.credentialId, credentials.id))
    .innerJoin(projects, eq(credentials.projectId, projects.id))
}

export function listSharesIndex(tx: Tx, params: ListSharesIndexParams): Promise<SharesIndexRow[]> {
  return indexFrom(tx)
    .where(indexWhere(params))
    .orderBy(desc(credentialShares.createdAt), desc(credentialShares.id))
    .limit(params.limit)
    .offset(params.offset)
}

export async function countSharesIndex(tx: Tx, params: ListSharesIndexParams): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)` })
    .from(credentialShares)
    .innerJoin(credentials, eq(credentialShares.credentialId, credentials.id))
    .innerJoin(projects, eq(credentials.projectId, projects.id))
    .where(indexWhere(params))
  return Number(row?.count ?? 0)
}
