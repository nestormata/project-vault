import { and, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import {
  credentialVersions,
  credentials,
  projects,
  vaultState,
  credentialDependencies,
} from '@project-vault/db/schema'
import { encrypt, withSecret, type EncryptedValue } from '@project-vault/crypto'
import { dedupeTags, tagDelta } from '../../lib/tags.js'
import { getPrimaryKey } from '../vault/key-service.js'
import type {
  AddVersionBody,
  CreateCredentialBody,
  ListCredentialsQuery,
  TagArrayBody,
} from './schema.js'

export class VersionConflictError extends Error {
  constructor() {
    super('Concurrent version creation conflict')
  }
}

type RevealCurrentValueResult =
  | { status: 'found'; value: string; versionNumber: number }
  | { status: 'not_found'; reason: 'not_found' | 'all_versions_purged' }

type CredentialListParams = {
  projectId: string
  query: ListCredentialsQuery
  limit: number
  offset: number
}
type TagUpdateMode = 'replace' | 'append'

function isUniqueViolation(error: unknown): boolean {
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined
  if (!cause || typeof cause !== 'object') return false
  return (cause as { code?: string }).code === '23505'
}

async function currentKeyVersion(tx: Tx): Promise<number> {
  const [vs] = await tx.select({ keyVersion: vaultState.keyVersion }).from(vaultState).limit(1)
  return vs?.keyVersion ?? 1
}

async function encryptValue(value: string): Promise<EncryptedValue> {
  const plaintext = Buffer.from(value, 'utf8')
  const key = getPrimaryKey()
  try {
    return await encrypt(plaintext, key)
  } finally {
    plaintext.fill(0)
    key.fill(0)
  }
}

export function serializeCredentialDetail(
  credential: typeof credentials.$inferSelect,
  currentVersionNumber: number
) {
  return {
    id: credential.id,
    projectId: credential.projectId,
    orgId: credential.orgId,
    name: credential.name,
    description: credential.description,
    tags: credential.tags,
    expiresAt: credential.expiresAt?.toISOString() ?? null,
    rotationSchedule: credential.rotationSchedule,
    retentionCount: credential.retentionCount,
    currentVersionNumber,
    createdBy: credential.createdBy,
    createdAt: credential.createdAt.toISOString(),
    updatedAt: credential.updatedAt.toISOString(),
  }
}

export async function findProjectInOrg(tx: Tx, projectId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.archivedAt)))
    .limit(1)
  return Boolean(rows[0])
}

function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (match) => `\\${match}`)
}

function parseTagFilter(rawTags: string | undefined): string[] {
  return (rawTags ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
}

function credentialListWhere(params: { projectId: string; query: ListCredentialsQuery }) {
  const filters = [eq(credentials.projectId, params.projectId)]
  const q = params.query.q?.trim()
  if (q) {
    const like = `%${escapeLikeTerm(q)}%`
    const searchFilter = or(ilike(credentials.name, like), ilike(credentials.description, like))
    if (searchFilter) filters.push(searchFilter)
  }

  const tagList = parseTagFilter(params.query.tags)
  if (tagList.length > 0) {
    filters.push(sql`${credentials.tags} @> ${JSON.stringify(tagList)}::jsonb`)
  }

  if (params.query.status === 'active') {
    filters.push(sql`(${credentials.expiresAt} IS NULL OR ${credentials.expiresAt} > now())`)
  } else if (params.query.status === 'expiring') {
    filters.push(
      sql`${credentials.expiresAt} > now() AND ${credentials.expiresAt} <= now() + make_interval(days => ${params.query.expiresWithin})`
    )
  } else if (params.query.status === 'expired') {
    filters.push(sql`${credentials.expiresAt} IS NOT NULL AND ${credentials.expiresAt} <= now()`)
  }

  return and(...filters)
}

export async function listCredentials(tx: Tx, params: CredentialListParams) {
  const where = credentialListWhere(params)
  const [{ total } = { total: 0 }] = await tx
    .select({ total: sql<number>`count(*)` })
    .from(credentials)
    .where(where)

  const rows = await tx
    .select({
      id: credentials.id,
      projectId: credentials.projectId,
      name: credentials.name,
      description: credentials.description,
      tags: credentials.tags,
      status: sql<'active' | 'expiring' | 'expired'>`CASE
        WHEN ${credentials.expiresAt} IS NOT NULL AND ${credentials.expiresAt} <= now() THEN 'expired'
        WHEN ${credentials.expiresAt} IS NOT NULL AND ${credentials.expiresAt} <= now() + make_interval(days => 30) THEN 'expiring'
        ELSE 'active'
      END`,
      expiresAt: credentials.expiresAt,
      rotationSchedule: credentials.rotationSchedule,
      createdAt: credentials.createdAt,
      updatedAt: credentials.updatedAt,
    })
    .from(credentials)
    .where(where)
    .orderBy(desc(credentials.createdAt), desc(credentials.id))
    .limit(params.limit)
    .offset(params.offset)

  const credentialIds = rows.map((row) => row.id)
  const versionRows =
    credentialIds.length === 0
      ? []
      : await tx
          .select({
            credentialId: credentialVersions.credentialId,
            currentVersionNumber: sql<number>`MAX(${credentialVersions.versionNumber})`,
          })
          .from(credentialVersions)
          .where(
            and(
              inArray(credentialVersions.credentialId, credentialIds),
              isNull(credentialVersions.purgedAt)
            )
          )
          .groupBy(credentialVersions.credentialId)
  const currentVersionByCredential = new Map(
    versionRows.map((row) => [row.credentialId, Number(row.currentVersionNumber)])
  )

  const activeDepRows =
    credentialIds.length === 0
      ? []
      : await tx
          .selectDistinct({ credentialId: credentialDependencies.credentialId })
          .from(credentialDependencies)
          .where(
            and(
              inArray(credentialDependencies.credentialId, credentialIds),
              isNull(credentialDependencies.archivedAt)
            )
          )
  const hasDependenciesByCredential = new Set(activeDepRows.map((row) => row.credentialId))

  return {
    total: Number(total),
    items: rows.map((row) => ({
      ...row,
      currentVersionNumber: currentVersionByCredential.get(row.id) ?? 1,
      hasDependencies: hasDependenciesByCredential.has(row.id),
      expiresAt: row.expiresAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  }
}

export async function createCredentialWithFirstVersion(
  tx: Tx,
  input: {
    orgId: string
    projectId: string
    userId: string
    body: CreateCredentialBody
  }
) {
  const keyVersion = await currentKeyVersion(tx)
  const encryptedValue = await encryptValue(input.body.value)

  const [credential] = await tx
    .insert(credentials)
    .values({
      orgId: input.orgId,
      projectId: input.projectId,
      name: input.body.name,
      description: input.body.description ?? null,
      tags: input.body.tags ?? [],
      expiresAt: input.body.expiresAt ? new Date(input.body.expiresAt) : null,
      rotationSchedule: input.body.rotationSchedule ?? null,
      createdBy: input.userId,
    })
    .returning()
  if (!credential) throw new Error('Credential insert returned no row')

  await tx.insert(credentialVersions).values({
    orgId: input.orgId,
    credentialId: credential.id,
    encryptedValue,
    keyVersion,
    versionNumber: 1,
    createdBy: input.userId,
  })

  return { credential, detail: serializeCredentialDetail(credential, 1) }
}

export async function findCredentialInProject(
  tx: Tx,
  params: { credentialId: string; projectId: string }
) {
  const [credential] = await tx
    .select()
    .from(credentials)
    .where(
      and(eq(credentials.id, params.credentialId), eq(credentials.projectId, params.projectId))
    )
    .limit(1)
  return credential ?? null
}

export async function updateCredentialTags(
  tx: Tx,
  params: {
    credentialId: string
    projectId: string
    body: TagArrayBody
    mode: TagUpdateMode
  }
) {
  const [row] = await tx
    .select({ id: credentials.id, tags: credentials.tags })
    .from(credentials)
    .where(
      and(eq(credentials.id, params.credentialId), eq(credentials.projectId, params.projectId))
    )
    .for('update')
    .limit(1)
  if (!row) return { status: 'not_found' as const }

  const incoming = dedupeTags(params.body.tags)
  const nextTags =
    params.mode === 'replace'
      ? incoming
      : [...row.tags, ...incoming.filter((tag) => !row.tags.includes(tag))]
  if (nextTags.length > 20) return { status: 'too_many_tags' as const }

  const [updated] = await tx
    .update(credentials)
    .set({ tags: nextTags })
    .where(eq(credentials.id, params.credentialId))
    .returning({ id: credentials.id, tags: credentials.tags })
  if (!updated) return { status: 'not_found' as const }

  const delta = tagDelta(row.tags, nextTags)
  return {
    status: 'updated' as const,
    data: updated,
    auditPayload: {
      mode: params.mode,
      added:
        params.mode === 'append' ? nextTags.filter((tag) => !row.tags.includes(tag)) : delta.added,
      removed: params.mode === 'append' ? [] : delta.removed,
      resultCount: nextTags.length,
    },
  }
}

export async function addCredentialVersion(
  tx: Tx,
  input: {
    orgId: string
    credentialId: string
    projectId: string
    userId: string
    body: AddVersionBody
  }
) {
  const [cred] = await tx
    .select({ id: credentials.id })
    .from(credentials)
    .where(and(eq(credentials.id, input.credentialId), eq(credentials.projectId, input.projectId)))
    .for('update')
    .limit(1)
  if (!cred) return null

  const [maxRow] = await tx
    .select({ max: sql<number>`COALESCE(MAX(${credentialVersions.versionNumber}), 0)` })
    .from(credentialVersions)
    .where(eq(credentialVersions.credentialId, input.credentialId))
  const nextVersion = Number(maxRow?.max ?? 0) + 1

  const keyVersion = await currentKeyVersion(tx)
  const encryptedValue = await encryptValue(input.body.value)

  try {
    const [version] = await tx
      .insert(credentialVersions)
      .values({
        orgId: input.orgId,
        credentialId: input.credentialId,
        encryptedValue,
        keyVersion,
        versionNumber: nextVersion,
        createdBy: input.userId,
      })
      .returning()
    if (!version) throw new Error('Credential version insert returned no row')
    return version
  } catch (error) {
    if (isUniqueViolation(error)) throw new VersionConflictError()
    throw error
  }
}

export async function revealCurrentValue(
  tx: Tx,
  params: { credentialId: string; projectId: string }
): Promise<RevealCurrentValueResult> {
  const credential = await findCredentialInProject(tx, params)
  if (!credential) return { status: 'not_found', reason: 'not_found' }

  const [version] = await tx
    .select({
      versionNumber: credentialVersions.versionNumber,
      encryptedValue: credentialVersions.encryptedValue,
    })
    .from(credentialVersions)
    .where(
      and(
        eq(credentialVersions.credentialId, params.credentialId),
        isNull(credentialVersions.purgedAt)
      )
    )
    .orderBy(desc(credentialVersions.versionNumber))
    .limit(1)

  if (!version || !version.encryptedValue) {
    return { status: 'not_found', reason: 'all_versions_purged' }
  }

  // reveal path: Buffer->string permitted here (the one sanctioned conversion site)
  const value = await withSecret(version.encryptedValue, async (plaintext) =>
    plaintext.toString('utf8')
  )
  return { status: 'found', value, versionNumber: version.versionNumber }
}

export async function listVersionHistory(
  tx: Tx,
  params: { credentialId: string; projectId: string }
) {
  const credential = await findCredentialInProject(tx, params)
  if (!credential) return null

  const rows = await tx
    .select({
      versionNumber: credentialVersions.versionNumber,
      createdBy: credentialVersions.createdBy,
      createdAt: credentialVersions.createdAt,
      purgedAt: credentialVersions.purgedAt,
    })
    .from(credentialVersions)
    .where(eq(credentialVersions.credentialId, params.credentialId))
    .orderBy(desc(credentialVersions.versionNumber))

  const currentVersionNumber = rows.find((row) => row.purgedAt === null)?.versionNumber

  return rows.map((row) => ({
    versionNumber: row.versionNumber,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    isCurrent: row.versionNumber === currentVersionNumber,
    purgedAt: row.purgedAt?.toISOString() ?? null,
  }))
}
