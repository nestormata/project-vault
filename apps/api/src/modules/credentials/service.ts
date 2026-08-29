import { and, desc, eq, gt, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import {
  credentialVersions,
  credentials,
  projects,
  credentialDependencies,
} from '@project-vault/db/schema'
import { withSecret, type EncryptedValue } from '@project-vault/crypto'
import type { Field, FieldMeta } from '@project-vault/shared'
import { dedupeTags, normalizeTag, tagDelta } from '../../lib/tags.js'
import { encryptValue } from '../../lib/encrypt-value.js'
import {
  currentKeyVersion,
  insertVersionAndSetCurrent,
  isUniqueViolation,
  lockCredentialInProject,
} from './db-helpers.js'
import {
  assertLegacyShapeSafe,
  buildFieldMeta,
  computeFieldDelta,
  fieldMetaForResponse,
  isFieldSetBody,
  parseFieldsFromPlaintext,
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
// Story 18.5 AC-4: reuses the rotation module's batch "latest rotation per credential, if
// badge-worthy" lookup — a genuinely new query (no prior "batch active-rotation-status" helper
// existed), kept in the rotation module since it queries the `rotations` table.
import { getActiveRotationBadgesByCredential } from '../rotation/service.js'

export class VersionConflictError extends Error {
  constructor() {
    super('Concurrent version creation conflict')
  }
}

// Story 13.3 — revealCurrentValue's discriminated result. `kind: 'value'` is the byte-for-byte
// unchanged legacy/single-default-field shape (AC-6); `kind: 'fields'` is the new structured
// multi-field shape (AC-4/AC-5). `revealedFields`, when present, is what the caller must persist
// to the new `audit_log_entries.revealed_fields` column — set whenever an explicit `?field=` was
// requested (even for a single-field collapse) or for a whole-secret multi-field reveal (the
// sensitive fields actually included); omitted for an implicit whole-secret legacy/single-
// default-field reveal, matching AC-6's "revealed_fields stays NULL" requirement.
export type RevealCurrentValueResult =
  | {
      status: 'found'
      kind: 'value'
      value: string
      versionNumber: number
      abandonedVersionExcluded: boolean
      revealedFields?: string[]
    }
  | {
      status: 'found'
      kind: 'fields'
      fields: Field[]
      schemaVersion: number
      versionNumber: number
      abandonedVersionExcluded: boolean
      revealedFields: string[]
    }
  | { status: 'not_found'; reason: 'not_found' | 'all_versions_purged' }
  // AC-7 — a well-formed `?field=` naming a key absent from this secret's field_meta.
  | { status: 'unknown_field'; key: string }

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
  fieldInfo: CredentialFieldInfo = DEFAULT_FIELD_INFO,
  // Story 13.3 AC-2 — eagerly-decrypted non-sensitive field values, keyed by field key. Empty
  // object for a legacy secret, a secret with no non-sensitive fields, or a degraded eager-decrypt
  // (see `eagerNonSensitiveFieldValues`).
  visibleFieldValues: Record<string, string> = {}
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
    visibleFieldValues,
    createdBy: credential.createdBy,
    createdAt: credential.createdAt.toISOString(),
    updatedAt: credential.updatedAt.toISOString(),
    // Story 28.5 AC5/AC6.
    archivedAt: credential.archivedAt?.toISOString() ?? null,
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
  // Story 28.5 AC5: default excludes archived secrets; `?includeArchived=true` includes them —
  // mirrors GET /projects' own `listWhere` construction exactly.
  if (!params.query.includeArchived) {
    filters.push(isNull(credentials.archivedAt))
  }
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
      archivedAt: credentials.archivedAt,
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
              isNull(credentialVersions.abandonedAt),
              // Story 5.6 AC-1.2: a staged (not yet promoted) version is never "current".
              isNotNull(credentialVersions.promotedAt)
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

  // Story 18.5 AC-4/AC-8: scoped to just this page's credentialIds, not the unpaginated set.
  const activeRotationByCredential = await getActiveRotationBadgesByCredential(tx, credentialIds)

  return {
    total: Number(total),
    items: rows.map((row) => ({
      ...row,
      currentVersionNumber: currentVersionByCredential.get(row.id) ?? 1,
      hasDependencies: hasDependenciesByCredential.has(row.id),
      activeRotation: activeRotationByCredential.get(row.id) ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      archivedAt: row.archivedAt?.toISOString() ?? null,
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
    // Story 5.6 AC-1.4: this path is not a staged rotation workflow — the first version is
    // immediately "current" by design, unchanged from the caller's perspective.
    promotedAt: new Date(),
  })

  // Story 13.3 AC-2 — the plaintext fields are already in hand at create time (no extra decrypt
  // needed); build the eager non-sensitive-values map directly from them.
  const visibleFieldValues: Record<string, string> = {}
  for (const field of resolved.fields) {
    if (!field.sensitive) visibleFieldValues[field.key] = field.value
  }

  return {
    credential,
    detail: serializeCredentialDetail(
      credential,
      1,
      { schemaVersion: 2, fields: fieldMeta },
      visibleFieldValues
    ),
  }
}

/**
 * Story 13.3 AC-2 — eagerly decrypts values for `sensitive: false` fields only, alongside the
 * existing field_meta-only detail response. This does NOT go through the audited `/value` route
 * (Dev Notes: "eager non-sensitive fetch is not an audited reveal") and must never write a
 * CREDENTIAL_VALUE_REVEALED entry.
 *
 * Failure Mode Analysis (AC-2 negative example): if the decrypt/parse throws (e.g. a corrupted
 * envelope), the whole detail view must still render — this returns an empty map so every
 * non-sensitive field falls back to a masked placeholder + its own "Reveal" button, and reports
 * the failure via `onDecryptFailure` for an operational (not audit) log, rather than 500ing the
 * entire detail response over one bad secret.
 */
async function eagerNonSensitiveFieldValues(params: {
  schemaVersion: number
  fieldMeta: FieldMeta[]
  encryptedValue: EncryptedValue | null | undefined
  onDecryptFailure?: (error: unknown) => void
}): Promise<Record<string, string>> {
  const nonSensitiveKeys = new Set(params.fieldMeta.filter((f) => !f.sensitive).map((f) => f.key))
  if (nonSensitiveKeys.size === 0 || !params.encryptedValue) return {}

  try {
    const plaintext = await withSecret(params.encryptedValue, async (buf) => buf.toString('utf8'))
    const fields = parseFieldsFromPlaintext(params.schemaVersion, plaintext)
    const values: Record<string, string> = {}
    for (const field of fields) {
      if (nonSensitiveKeys.has(field.key)) values[field.key] = field.value
    }
    return values
  } catch (error) {
    params.onDecryptFailure?.(error)
    return {}
  }
}

export async function getCredentialDetail(
  tx: Tx,
  params: { credentialId: string; projectId: string },
  options: { onEagerDecryptFailure?: (error: unknown) => void } = {}
) {
  const credential = await findCredentialInProject(tx, params)
  if (!credential) return null

  // Story 13.2 — the current (highest non-purged, non-abandoned) version's format so the detail
  // response can carry schema_version + field metadata for the field-list UI. A legacy
  // schema_version = 1 row (or null field_meta) wraps into a single unnamed default field (AC-7).
  const versionRow = await selectCurrentVersionMeta(tx, params.credentialId)

  const currentVersionNumber = Number(versionRow?.versionNumber ?? 1)
  const schemaVersion = versionRow?.schemaVersion ?? 1
  const fieldMeta = fieldMetaForResponse(schemaVersion, versionRow?.fieldMeta)

  const visibleFieldValues = await eagerNonSensitiveFieldValues({
    schemaVersion,
    fieldMeta,
    encryptedValue: versionRow?.encryptedValue,
    onDecryptFailure: options.onEagerDecryptFailure,
  })

  return serializeCredentialDetail(
    credential,
    currentVersionNumber,
    { schemaVersion, fields: fieldMeta },
    visibleFieldValues
  )
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

export type ArchiveCredentialResult = {
  id: string
  name: string
  archivedAt: Date
}

/**
 * Story 28.5 AC2 — commits the archive UPDATE with the same atomic conditional-update/race-check
 * shape as project archival: `WHERE id = $credentialId AND archived_at IS NULL RETURNING`. Zero
 * rows means either the credential doesn't exist or a racing request archived it first between
 * the caller's own pre-check and this UPDATE — the route treats both as `already_archived`.
 * Thin-routes convention: this is the only place that writes `archived_at`/`archived_by`.
 */
export async function archiveCredential(
  tx: Tx,
  params: { credentialId: string; userId: string }
): Promise<ArchiveCredentialResult | null> {
  const [archived] = await tx
    .update(credentials)
    .set({ archivedAt: new Date(), archivedBy: params.userId, updatedAt: new Date() })
    .where(and(eq(credentials.id, params.credentialId), isNull(credentials.archivedAt)))
    .returning({ id: credentials.id, name: credentials.name, archivedAt: credentials.archivedAt })
  if (!archived || !archived.archivedAt) return null
  return { id: archived.id, name: archived.name, archivedAt: archived.archivedAt }
}

/** Story 28.5 AC3 — the symmetric reverse of `archiveCredential`. */
export async function unarchiveCredential(
  tx: Tx,
  params: { credentialId: string }
): Promise<{ id: string; name: string } | null> {
  const [restored] = await tx
    .update(credentials)
    .set({ archivedAt: null, archivedBy: null, updatedAt: new Date() })
    .where(and(eq(credentials.id, params.credentialId), isNotNull(credentials.archivedAt)))
    .returning({ id: credentials.id, name: credentials.name })
  return restored ?? null
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
    renamedFields: Array<{ from: string; to: string }>
  }
}

// The current (highest non-purged/non-abandoned) version's number + value-envelope format. Shared
// by getCredentialDetail (field metadata for the response) and addCredentialVersion (the "before"
// side of the AC-9 audit delta), so the two never diverge on what "current version" means.
// Story 5.6 AC-1.2: "current" now REQUIRES promotedAt IS NOT NULL (a staged, not-yet-promoted
// version is never "current"), and orders by (promotedAt DESC, versionNumber DESC) rather than
// versionNumber DESC alone — see Example 1c for why the promotedAt-first ordering matters even
// though the WHERE clause alone rules out most ordering hazards today.
export async function selectCurrentVersionMeta(
  tx: Tx,
  credentialId: string
): Promise<
  | {
      versionNumber: number
      schemaVersion: number
      fieldMeta: unknown
      // Story 13.3 AC-2 — needed by getCredentialDetail's eager non-sensitive-value decrypt.
      encryptedValue: EncryptedValue | null
    }
  | undefined
> {
  const [row] = await tx
    .select({
      versionNumber: credentialVersions.versionNumber,
      schemaVersion: credentialVersions.schemaVersion,
      fieldMeta: credentialVersions.fieldMeta,
      encryptedValue: credentialVersions.encryptedValue,
    })
    .from(credentialVersions)
    .where(
      and(
        eq(credentialVersions.credentialId, credentialId),
        isNull(credentialVersions.purgedAt),
        isNull(credentialVersions.abandonedAt),
        isNotNull(credentialVersions.promotedAt)
      )
    )
    .orderBy(desc(credentialVersions.promotedAt), desc(credentialVersions.versionNumber))
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

  // Current version's field keys → the "before" side of the AC-9 audit delta, and also used to
  // guard the legacy `{ value }` shape below.
  const oldKeys = await currentFieldKeys(tx, input.credentialId)

  // A legacy `{ value }` body must never be usable to silently collapse an already-multi-field
  // secret down to one field (data loss) — it exists purely for backward compatibility with
  // pre-existing single-value clients (AC-5/AC-7), not as a way to blow away a template-based
  // secret's other fields. Throws before any write, zero side effects, no audit event.
  assertLegacyShapeSafe(!isFieldSetBody(input.body), oldKeys)

  // Story 13.2 — uniqueness-validate the FINAL field set before any write (may throw
  // FieldKeyConflictError → 409 with zero side effects, AC-3); a legacy `{ value }` body
  // synthesizes a single default field (AC-7 legacy → schema_version 2 transition on first edit).
  const resolved = resolveFieldSet(input.body)
  const fieldMeta = buildFieldMeta(resolved)

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
      // Story 5.6 AC-1.4: multi-field edits are not a staged rotation workflow — immediately
      // "current" by design, unchanged from the caller's perspective.
      promotedAt: new Date(),
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
        renamedFields: delta.renamedFields,
      },
    }
  } catch (error) {
    if (isUniqueViolation(error)) throw new VersionConflictError()
    throw error
  }
}

/**
 * Story 13.3 Subtask 2.3/AC-7 — validates a requested `?field=` against the REAL field_meta
 * before any decrypt/audit-write occurs. A genuine schema_version = 1 legacy row has no
 * field_meta at all, so ANY `?field=` name is rejected (AC-6's lookalike-case distinction); a
 * schema_version >= 2 row (single- or multi-field) is validated against its actual declared keys.
 * Returns `undefined` when the field is absent or valid; the offending key when invalid.
 */
function invalidRequestedField(
  field: string | undefined,
  schemaVersion: number,
  fieldMeta: unknown
): string | undefined {
  if (field === undefined) return undefined
  if (schemaVersion < 2) return field
  const declaredKeys = fieldMetaForResponse(schemaVersion, fieldMeta).map((f) => f.key)
  return declaredKeys.includes(field) ? undefined : field
}

export async function revealCurrentValue(
  tx: Tx,
  params: { credentialId: string; projectId: string; field?: string }
): Promise<RevealCurrentValueResult> {
  const credential = await findCredentialInProject(tx, params)
  if (!credential) return { status: 'not_found', reason: 'not_found' }

  const [version] = await tx
    .select({
      versionNumber: credentialVersions.versionNumber,
      encryptedValue: credentialVersions.encryptedValue,
      schemaVersion: credentialVersions.schemaVersion,
      fieldMeta: credentialVersions.fieldMeta,
    })
    .from(credentialVersions)
    .where(
      and(
        eq(credentialVersions.credentialId, params.credentialId),
        isNull(credentialVersions.purgedAt),
        // Story 5.3 AC-13/CR5: excludes a version abandoned by a stale-recovery `abandon` call
        // or superseded by break-glass (ADR-5.3-04) from ever being served as "current" —
        // always-true no-op for any credential that has never had a rotation/abandonment.
        isNull(credentialVersions.abandonedAt),
        // Story 5.6 AC-1.2: a staged (not yet promoted) version is never "current" — this is the
        // literal behavior inversion the story exists to deliver (Example 1b).
        isNotNull(credentialVersions.promotedAt)
      )
    )
    .orderBy(desc(credentialVersions.promotedAt), desc(credentialVersions.versionNumber))
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

  const invalidField = invalidRequestedField(params.field, version.schemaVersion, version.fieldMeta)
  if (invalidField !== undefined) {
    return { status: 'unknown_field', key: invalidField }
  }

  // reveal path: Buffer->string permitted here (the one sanctioned conversion site)
  const plaintext = await withSecret(version.encryptedValue, async (buf) => buf.toString('utf8'))
  // Story 13.2 AC-7 — legacy (schema_version = 1) rows decrypt to a bare string; a
  // single-default-field v2 row unwraps to its bare value (backward compatible); a genuine
  // multi-field v2 row returns the full JSON field envelope. The stored ciphertext is never
  // re-parsed or re-encrypted. Story 13.3 — parsing via parseFieldsFromPlaintext (rather than a
  // third parallel envelope parser) determines whether this is genuinely multi-field.
  const fields = parseFieldsFromPlaintext(version.schemaVersion, plaintext)
  const isGenuineMultiField = version.schemaVersion >= 2 && fields.length > 1

  if (!isGenuineMultiField) {
    // Legacy or single-default-field v2 — AC-6: byte-for-byte unchanged bare-string shape. When
    // an explicit `?field=` was requested (and validated above), the caller still needs to know
    // which key to attribute the audit entry to (AC-4's "endpoint was called" boundary) — but an
    // *implicit* whole-secret reveal of a legacy/single-default-field secret leaves
    // `revealedFields` unset, so the caller writes `NULL` (AC-6), not `[]`.
    const value = unwrapRevealValue(version.schemaVersion, plaintext)
    return {
      status: 'found',
      kind: 'value',
      value,
      versionNumber: version.versionNumber,
      abandonedVersionExcluded,
      ...(params.field !== undefined ? { revealedFields: [params.field] } : {}),
    }
  }

  if (params.field !== undefined) {
    // Already validated against field_meta above; a mismatch here would mean field_meta and the
    // decrypted envelope disagree — treat defensively as unknown rather than trusting either.
    const match = fields.find((f) => f.key === params.field)
    if (!match) return { status: 'unknown_field', key: params.field }
    return {
      status: 'found',
      kind: 'fields',
      fields: [match],
      schemaVersion: version.schemaVersion,
      versionNumber: version.versionNumber,
      abandonedVersionExcluded,
      // AC-4 negative example: the audited-reveal-action boundary is "this endpoint was called",
      // not "the field happened to be sensitive" — recorded regardless of `match.sensitive`.
      revealedFields: [match.key],
    }
  }

  // AC-5 — whole-secret reveal of a genuine multi-field secret: every field's value is returned,
  // but `revealedFields` names only the genuinely-sensitive ones actually included, in field_meta
  // declared order (not alphabetical/insertion-of-request order).
  return {
    status: 'found',
    kind: 'fields',
    fields,
    schemaVersion: version.schemaVersion,
    versionNumber: version.versionNumber,
    abandonedVersionExcluded,
    revealedFields: fields.filter((f) => f.sensitive).map((f) => f.key),
  }
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
      promotedAt: credentialVersions.promotedAt,
      schemaVersion: credentialVersions.schemaVersion,
    })
    .from(credentialVersions)
    .where(eq(credentialVersions.credentialId, params.credentialId))
    .orderBy(desc(credentialVersions.versionNumber))

  // Story 5.3 AC-14/CR5 + Story 5.6 AC-1.2: "current" excludes abandoned/purged versions AND
  // (new) requires promotedAt to be set, ranked by (promotedAt DESC, versionNumber DESC) — a
  // staged (not yet promoted) version, even if it's the highest version number, is never
  // "current". Computed in JS (not a second query) since `rows` is already fetched in full.
  const currentVersionNumber = rows
    .filter((row) => row.purgedAt === null && row.abandonedAt === null && row.promotedAt !== null)
    .sort((a, b) => {
      const byPromotedAt = (b.promotedAt as Date).getTime() - (a.promotedAt as Date).getTime()
      return byPromotedAt !== 0 ? byPromotedAt : b.versionNumber - a.versionNumber
    })[0]?.versionNumber

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
