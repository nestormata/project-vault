import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { auditLogEntries, userIdentityTokens } from '@project-vault/db/schema'
import { actorDisplayNameFor, batchResolveActorDisplayNames } from './actor-display-name.js'

export type SearchAuditEventsInput = {
  actorId?: string
  eventType?: string
  resourceId?: string
  projectId?: string
  from?: string
  to?: string
  offset: number
  limit: number
}

export type AuditEventSearchRow = {
  id: string
  eventType: string
  actorDisplayName: string
  resourceId: string | null
  resourceType: string | null
  projectId: string | null
  ipAddress: string | null
  createdAt: string
}

export type SearchAuditEventsResult = {
  data: AuditEventSearchRow[]
  total: number
}

/** D6 — resolves `actorId` (a real user id) to the `user_identity_tokens` row ids that
 * belong to it. `user_identity_tokens.user_id` has no UNIQUE constraint, so this returns every
 * matching token id (defensive `IN (...)`, not a single-value assumption). */
export async function resolveActorTokenIds(tx: Tx, actorId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: userIdentityTokens.id })
    .from(userIdentityTokens)
    .where(eq(userIdentityTokens.userId, actorId))
  return rows.map((row) => row.id)
}

type SearchConditions = ReturnType<typeof eq>[]

/** Extracted purely to keep searchAuditEvents()'s own cyclomatic complexity down — each filter
 * dimension is independent and optional (AC-4). */
function buildNonActorConditions(
  input: Omit<SearchAuditEventsInput, 'actorId' | 'offset' | 'limit'>
): SearchConditions {
  const conditions: SearchConditions = []
  if (input.eventType) conditions.push(eq(auditLogEntries.eventType, input.eventType))
  if (input.resourceId) conditions.push(eq(auditLogEntries.resourceId, input.resourceId))
  if (input.projectId) conditions.push(eq(auditLogEntries.projectId, input.projectId))
  if (input.from) conditions.push(gte(auditLogEntries.createdAt, new Date(input.from)))
  if (input.to) conditions.push(lte(auditLogEntries.createdAt, new Date(input.to)))
  return conditions
}

export async function searchAuditEvents(
  tx: Tx,
  input: SearchAuditEventsInput
): Promise<SearchAuditEventsResult> {
  const conditions = buildNonActorConditions(input)

  if (input.actorId) {
    const tokenIds = await resolveActorTokenIds(tx, input.actorId)
    // AC-2 edge case — a valid-shaped actorId with no matching token resolves to zero token
    // ids; the search must return an empty result set, not a 404/422.
    if (tokenIds.length === 0) return { data: [], total: 0 }
    conditions.push(inArray(auditLogEntries.actorTokenId, tokenIds))
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined

  const [totalRow] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(auditLogEntries)
    .where(whereClause)
  const total = totalRow?.count ?? 0

  const rows = await tx
    .select({
      id: auditLogEntries.id,
      eventType: auditLogEntries.eventType,
      actorTokenId: auditLogEntries.actorTokenId,
      actorType: auditLogEntries.actorType,
      resourceId: auditLogEntries.resourceId,
      resourceType: auditLogEntries.resourceType,
      projectId: auditLogEntries.projectId,
      ipAddress: auditLogEntries.ipAddress,
      createdAt: auditLogEntries.createdAt,
    })
    .from(auditLogEntries)
    .where(whereClause)
    .orderBy(desc(auditLogEntries.createdAt), desc(auditLogEntries.id))
    .limit(input.limit)
    .offset(input.offset)

  const displayNameByTokenId = await batchResolveActorDisplayNames(
    tx,
    rows.map((row) => row.actorTokenId)
  )

  const data = rows.map((row) => ({
    id: row.id,
    eventType: row.eventType,
    actorDisplayName: actorDisplayNameFor(row.actorType, row.actorTokenId, displayNameByTokenId),
    resourceId: row.resourceId,
    resourceType: row.resourceType,
    projectId: row.projectId,
    ipAddress: row.ipAddress,
    createdAt: row.createdAt.toISOString(),
  }))

  return { data, total }
}
