import { and, eq, ilike, isNull, or, sql, type AnyColumn } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { credentials, projects } from '@project-vault/db/schema'
import type { SearchResultItem, SearchType } from './schema.js'

type ExecuteSearchInput = {
  tx: Tx
  orgId: string
  q: string
  types: SearchType[]
  limit: number
  // Story 9.3 D8.3/AC-11: page-based offset into the concatenated (credentials-then-projects)
  // result order — see executeSearch()'s doc comment for how offset is split across the two
  // independently-queried sources.
  offset: number
}

function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (match) => `\\${match}`)
}

export function generateSnippet(text: string | null, query: string): string | null {
  if (!text) return null
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return text.slice(0, 120)
  const start = Math.max(0, idx - 30)
  const end = Math.min(text.length, idx + query.length + 60)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${text.slice(start, end)}${suffix}`
}

function credentialMatchedField(
  row: {
    name: string
    description: string | null
    tags: string[]
  },
  q: string
): 'name' | 'description' | 'tags' {
  const needle = q.toLowerCase()
  if (row.name.toLowerCase().includes(needle)) return 'name'
  if (row.description?.toLowerCase().includes(needle)) return 'description'
  return 'tags'
}

function projectMatchedField(row: { name: string; tags: string[] }, q: string): 'name' | 'tags' {
  return row.name.toLowerCase().includes(q.toLowerCase()) ? 'name' : 'tags'
}

const relevanceOrderSql = (nameColumn: AnyColumn, q: string) =>
  sql`
    CASE
      WHEN LOWER(${nameColumn}) = LOWER(${q}) THEN 3
      WHEN LOWER(${nameColumn}) ILIKE LOWER(${`${q}%`}) THEN 2
      ELSE 1
    END DESC
  `

function credentialMatchWhere(orgId: string, like: string) {
  return and(
    eq(credentials.orgId, orgId),
    eq(projects.orgId, orgId),
    isNull(projects.archivedAt),
    or(
      ilike(credentials.name, like),
      ilike(credentials.description, like),
      sql`CAST(${credentials.tags} AS text) ILIKE ${like}`
    )
  )
}

function projectMatchWhere(orgId: string, like: string) {
  return and(
    eq(projects.orgId, orgId),
    isNull(projects.archivedAt),
    or(ilike(projects.name, like), sql`CAST(${projects.tags} AS text) ILIKE ${like}`)
  )
}

async function countCredentials(tx: Tx, orgId: string, q: string): Promise<number> {
  const like = `%${escapeLikeTerm(q)}%`
  const [row] = await tx
    .select({ count: sql<number>`count(*)` })
    .from(credentials)
    .innerJoin(projects, eq(credentials.projectId, projects.id))
    .where(credentialMatchWhere(orgId, like))
  return Number(row?.count ?? 0)
}

async function countProjects(tx: Tx, orgId: string, q: string): Promise<number> {
  const like = `%${escapeLikeTerm(q)}%`
  const [row] = await tx
    .select({ count: sql<number>`count(*)` })
    .from(projects)
    .where(projectMatchWhere(orgId, like))
  return Number(row?.count ?? 0)
}

async function searchCredentials(
  tx: Tx,
  orgId: string,
  q: string,
  limit: number,
  offset: number
): Promise<SearchResultItem[]> {
  const like = `%${escapeLikeTerm(q)}%`
  const rows = await tx
    .select({
      id: credentials.id,
      name: credentials.name,
      description: credentials.description,
      tags: credentials.tags,
      expiresAt: credentials.expiresAt,
      projectId: projects.id,
      projectName: projects.name,
      updatedAt: credentials.updatedAt,
    })
    .from(credentials)
    .innerJoin(projects, eq(credentials.projectId, projects.id))
    .where(credentialMatchWhere(orgId, like))
    .orderBy(relevanceOrderSql(credentials.name, q), sql`${credentials.updatedAt} DESC`)
    .limit(limit)
    .offset(offset)

  return rows.map((row) => ({
    type: 'credential' as const,
    id: row.id,
    name: row.name,
    description: row.description,
    tags: row.tags,
    projectId: row.projectId,
    projectName: row.projectName,
    matchedField: credentialMatchedField(row, q),
    snippet: generateSnippet(row.description ?? row.name, q),
    expiresAt: row.expiresAt?.toISOString() ?? null,
  }))
}

async function searchProjects(
  tx: Tx,
  orgId: string,
  q: string,
  limit: number,
  offset: number
): Promise<SearchResultItem[]> {
  const like = `%${escapeLikeTerm(q)}%`
  const rows = await tx
    .select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      tags: projects.tags,
      slug: projects.slug,
      updatedAt: projects.updatedAt,
      credentialCount: sql<number>`(
        SELECT count(*)::int
        FROM ${credentials}
        WHERE ${credentials.projectId} = ${projects.id}
          AND ${credentials.orgId} = ${orgId}
      )`,
    })
    .from(projects)
    .where(projectMatchWhere(orgId, like))
    .orderBy(relevanceOrderSql(projects.name, q), sql`${projects.updatedAt} DESC`)
    .limit(limit)
    .offset(offset)

  return rows.map((row) => ({
    type: 'project' as const,
    id: row.id,
    name: row.name,
    description: row.description,
    tags: row.tags,
    slug: row.slug,
    matchedField: projectMatchedField(row, q),
    snippet: generateSnippet(row.description ?? row.name, q),
    credentialCount: Number(row.credentialCount ?? 0),
  }))
}

/**
 * Story 9.3 D8.3/AC-11: `results` is a fixed concatenation of credential matches followed by
 * project matches (unchanged ordering from before this story) — `offset` therefore first consumes
 * credential matches, then continues into project matches once the credential source is
 * exhausted, so paging through `page=1,2,3...` walks the exact same logical ordering a caller
 * would see requesting the whole unpaginated list at once. `total` is now a genuine
 * database-wide count of matching rows (not capped at `limit`, unlike the previous
 * `trimmed.length` placeholder), which is what makes a real `hasNext` computation possible.
 */
export async function executeSearch(input: ExecuteSearchInput): Promise<{
  results: SearchResultItem[]
  total: number
}> {
  const { tx, orgId, q, types, limit, offset } = input

  const credTotal = types.includes('credentials') ? await countCredentials(tx, orgId, q) : 0
  const projTotal = types.includes('projects') ? await countProjects(tx, orgId, q) : 0
  const total = credTotal + projTotal

  const results: SearchResultItem[] = []

  if (types.includes('credentials') && offset < credTotal) {
    results.push(...(await searchCredentials(tx, orgId, q, limit, offset)))
  }

  const remaining = limit - results.length
  if (types.includes('projects') && remaining > 0) {
    const projectOffset = Math.max(0, offset - credTotal)
    results.push(...(await searchProjects(tx, orgId, q, remaining, projectOffset)))
  }

  return { results, total }
}
