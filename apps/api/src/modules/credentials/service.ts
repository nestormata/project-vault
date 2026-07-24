import { and, desc, eq, gt, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import {
  credentialVersions,
  credentials,
  projects,
  credentialDependencies,
} from '@project-vault/db/schema'
import { withSecret } from '@project-vault/crypto'
import type { FieldMeta } from '@project-vault/shared'
import { dedupeTags, normalizeTag, tagDelta } from '../../lib/tags.js'
import { encryptValue } from '../../lib/encrypt-value.js'
import {
  currentKeyVersion,
  insertVersionAndSetCurrent,
  isUniqueViolation,
  lockCredentialInProject,
} from './db-helpers.js'
import {
  buildFieldMeta,
  computeFieldDelta,
  fieldMetaForResponse,
  resolveFieldSet,
  serializeFieldEnvelope,
  unwrapRevealValue,
} from './field-set.js'
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
  | {
      status: 'found'
      value: string
      versionNumber: number
      // Story 5.5 AC-3: true when a higher-numbered, non-purged version exists but was excluded
      // because it was abandoned (stale-recovery abandon or break-glass supersession) — the
      // caller (routes.ts) uses this to emit the AC-3 structured log/metric.
      abandonedVersionExcluded: boolean
    }
  | { status: 'not_found'; reason: 'not_found' | 'all_versions_purged' }

type CredentialListParams = {
  orgId: string
  projectId: string
  query: ListCredentialsQuery
  limit: number
  offset: number
}
type TagUpdateMode = 'replace' | 'append'

export type CredentialFieldInfo = {
  schemaVersion: number
  fields: FieldMeta[]
}

// Story 13.2 — default field info for a freshly-created single-default-field secret, and the
// fallback for callers that don't supply it (keeps the serialize helper's older 2-arg call sites,
// e.g. the pure serialize test, working).
const DEFAULT_FIELD_INFO: CredentialFieldInfo = {
  schemaVersion: 2,
  fields: [{ key: 'value', sensitive: true }],
}

export function serializeCredentialDetail(
  credential: typeof credentials.$inferSelect,
  currentVersionNumber: number,
  fieldInfo: CredentialFieldInfo = DEFAULT_FIELD_INFO
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
    cacheable: credential.cacheable,
    retentionCount: credential.retentionCount,
    currentVersionNumber,
    schemaVersion: fieldInfo.schemaVersion,
    fields: fieldInfo.fields,
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
    .map(normalizeTag)
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
              isNull(credentialVersions.purgedAt),
              // Story 5.3 AC-13/AC-14 regression fix: without this, an abandoned version (higher
              // versionNumber, never renumbered — CR5) would be reported as "current" here even
              // though revealCurrentValue()/listVersionHistory() correctly roll back to the prior
              // version — the exact currentVersionNumber-disagreement failure mode the story's
              // own Pre-mortem Failure Mode #2 warns about, just at this call site instead.
              isNull(credentialVersions.abandonedAt)
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
              eq(credentialDependencies.orgId, params.orgId),
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
  // Story 13.2 — every new create writes schema_version = 2. A legacy `{ value }` body synthesizes
  // exactly one default field (AC-5); a `{ fields }` body is uniqueness-validated first (may throw
  // FieldKeyConflictError → 409, before any write).
  const resolved = resolveFieldSet(input.body)
  const fieldMeta = buildFieldMeta(resolved)
  const encryptedValue = await encryptValue(serializeFieldEnvelope(resolved))

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
      // Story 7.2 D7 — defaults to true (opt-out, not opt-in) if omitted.
      cacheable: input.body.cacheable ?? true,
      createdBy: input.userId,
    })
    .returning()
  if (!credential) throw new Error('Credential insert returned no row')

  await insertVersionAndSetCurrent(tx, {
    orgId: input.orgId,
    credentialId: credential.id,
    encryptedValue,
    keyVersion,
    versionNumber: 1,
    schemaVersion: 2,
    fieldMeta,
    createdBy: input.userId,
  })

  return {
    credential,
    detail: serializeCredentialDetail(credential, 1, { schemaVersion: 2, fields: fieldMeta }),
  }
}

export async function getCredentialDetail(
  tx: Tx,
  params: { credentialId: string; projectId: string }
) {
  const credential = await findCredentialInProject(tx, params)
  if (!credential) return null

  // Story 13.2 — the current (highest non-purged, non-abandoned) version's format so the detail
  // response can carry schema_version + field metadata for the field-list UI. A legacy
  // schema_version = 1 row (or null field_meta) wraps into a single unnamed default field (AC-7).
  const versionRow = await selectCurrentVersionMeta(tx, params.credentialId)

  const currentVersionNumber = Number(versionRow?.versionNumber ?? 1)
  const schemaVersion = versionRow?.schemaVersion ?? 1
  return serializeCredentialDetail(credential, currentVersionNumber, {
    schemaVersion,
    fields: fieldMetaForResponse(schemaVersion, versionRow?.fieldMeta),
  })
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

/**
 * Story 7.2 D6 — `credentials.name` has no uniqueness constraint (Epic 2 never added one), so
 * this returns ALL matches rather than guessing "most recent" or "first alphabetically" on
 * ambiguity; the machine value-retrieval handler (AC-6/AC-7) is responsible for turning a
 * multi-row result into a 409 `ambiguous_credential_name` response.
 */
export async function findCredentialByNameInProject(
  tx: Tx,
  params: { projectId: string; name: string }
) {
  return tx
    .select()
    .from(credentials)
    .where(and(eq(credentials.projectId, params.projectId), eq(credentials.name, params.name)))
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

export type AddCredentialVersionResult = {
  version: typeof credentialVersions.$inferSelect
  auditPayload: {
    versionNumber: number
    template?: string
    addedFields: string[]
    removedFields: string[]
  }
}

// The current (highest non-purged/non-abandoned) version's number + value-envelope format. Shared
// by getCredentialDetail (field metadata for the response) and addCredentialVersion (the "before"
// side of the AC-9 audit delta), so the two never diverge on what "current version" means.
async function selectCurrentVersionMeta(
  tx: Tx,
  credentialId: string
): Promise<{ versionNumber: number; schemaVersion: number; fieldMeta: unknown } | undefined> {
  const [row] = await tx
    .select({
      versionNumber: credentialVersions.versionNumber,
      schemaVersion: credentialVersions.schemaVersion,
      fieldMeta: credentialVersions.fieldMeta,
    })
    .from(credentialVersions)
    .where(
      and(
        eq(credentialVersions.credentialId, credentialId),
        isNull(credentialVersions.purgedAt),
        isNull(credentialVersions.abandonedAt)
      )
    )
    .orderBy(desc(credentialVersions.versionNumber))
    .limit(1)
  return row
}

async function currentFieldKeys(tx: Tx, credentialId: string): Promise<string[]> {
  const row = await selectCurrentVersionMeta(tx, credentialId)
  return fieldMetaForResponse(row?.schemaVersion ?? 1, row?.fieldMeta).map((f) => f.key)
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
): Promise<AddCredentialVersionResult | null> {
  const cred = await lockCredentialInProject(tx, {
    credentialId: input.credentialId,
    projectId: input.projectId,
  })
  if (!cred) return null

  // Story 13.2 — uniqueness-validate the FINAL field set before any write (may throw
  // FieldKeyConflictError → 409 with zero side effects, AC-3); a legacy `{ value }` body
  // synthesizes a single default field (AC-7 legacy → schema_version 2 transition on first edit).
  const resolved = resolveFieldSet(input.body)
  const fieldMeta = buildFieldMeta(resolved)

  // Current version's field keys → the "before" side of the AC-9 audit delta.
  const oldKeys = await currentFieldKeys(tx, input.credentialId)

  const [maxRow] = await tx
    .select({ max: sql<number>`COALESCE(MAX(${credentialVersions.versionNumber}), 0)` })
    .from(credentialVersions)
    .where(eq(credentialVersions.credentialId, input.credentialId))
  const nextVersion = Number(maxRow?.max ?? 0) + 1

  const keyVersion = await currentKeyVersion(tx)
  const encryptedValue = await encryptValue(serializeFieldEnvelope(resolved))

  try {
    // Story 13.2 AC-4 — insert the new version and flip current_version_id atomically (shared helper).
    const version = await insertVersionAndSetCurrent(tx, {
      orgId: input.orgId,
      credentialId: input.credentialId,
      encryptedValue,
      keyVersion,
      versionNumber: nextVersion,
      schemaVersion: 2,
      fieldMeta,
      createdBy: input.userId,
    })

    const delta = computeFieldDelta(
      oldKeys,
      fieldMeta.map((f) => f.key)
    )
    return {
      version,
      auditPayload: {
        versionNumber: version.versionNumber,
        ...(resolved.template ? { template: resolved.template } : {}),
        addedFields: delta.addedFields,
        removedFields: delta.removedFields,
      },
    }
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
      schemaVersion: credentialVersions.schemaVersion,
    })
    .from(credentialVersions)
    .where(
      and(
        eq(credentialVersions.credentialId, params.credentialId),
        isNull(credentialVersions.purgedAt),
        // Story 5.3 AC-13/CR5: excludes a version abandoned by a stale-recovery `abandon` call
        // or superseded by break-glass (ADR-5.3-04) from ever being served as "current" —
        // always-true no-op for any credential that has never had a rotation/abandonment.
        isNull(credentialVersions.abandonedAt)
      )
    )
    .orderBy(desc(credentialVersions.versionNumber))
    .limit(1)

  if (!version?.encryptedValue) {
    return { status: 'not_found', reason: 'all_versions_purged' }
  }

  // Story 5.5 AC-3: a single cheap, indexed (credential_id) lookup — proportional to the risk
  // being instrumented, not a second round-trip on every reveal that duplicates real work. Only
  // ever true for a credential that has actually had a rotation abandoned/superseded.
  const [higherAbandonedVersion] = await tx
    .select({ versionNumber: credentialVersions.versionNumber })
    .from(credentialVersions)
    .where(
      and(
        eq(credentialVersions.credentialId, params.credentialId),
        isNull(credentialVersions.purgedAt),
        isNotNull(credentialVersions.abandonedAt),
        gt(credentialVersions.versionNumber, version.versionNumber)
      )
    )
    .limit(1)
  const abandonedVersionExcluded = Boolean(higherAbandonedVersion)

  // reveal path: Buffer->string permitted here (the one sanctioned conversion site)
  const plaintext = await withSecret(version.encryptedValue, async (buf) => buf.toString('utf8'))
  // Story 13.2 AC-7 — legacy (schema_version = 1) rows decrypt to a bare string; a
  // single-default-field v2 row unwraps to its bare value (backward compatible); a genuine
  // multi-field v2 row returns the full JSON field envelope. The stored ciphertext is never
  // re-parsed or re-encrypted.
  const value = unwrapRevealValue(version.schemaVersion, plaintext)
  return { status: 'found', value, versionNumber: version.versionNumber, abandonedVersionExcluded }
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
      abandonedAt: credentialVersions.abandonedAt,
      schemaVersion: credentialVersions.schemaVersion,
    })
    .from(credentialVersions)
    .where(eq(credentialVersions.credentialId, params.credentialId))
    .orderBy(desc(credentialVersions.versionNumber))

  // Story 5.3 AC-14/CR5: "current" also excludes abandoned versions — can fall all the way back
  // to the credential's original (pre-rotation) version if its only rotation was abandoned
  // (the "smallest possible abandon case" edge case). Always-true no-op (identical to the
  // pre-5.3 behavior) for any credential that has never had an abandonment.
  const currentVersionNumber = rows.find(
    (row) => row.purgedAt === null && row.abandonedAt === null
  )?.versionNumber

  return rows.map((row) => ({
    versionNumber: row.versionNumber,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    isCurrent: row.versionNumber === currentVersionNumber,
    purgedAt: row.purgedAt?.toISOString() ?? null,
    abandonedAt: row.abandonedAt?.toISOString() ?? null,
    schemaVersion: row.schemaVersion,
  }))
}
