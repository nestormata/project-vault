import { sql } from 'drizzle-orm'
import { z } from 'zod/v4'
import type { Tx } from '@project-vault/db'
import {
  CREDENTIAL_TEMPLATE_FIELDS,
  CredentialOperationalContextSchema,
  FieldMetaSchema,
  MAX_FIELDS_PER_SECRET,
  normalizeFieldKey,
  type CredentialOperationalContext,
  type CredentialTemplate,
  type FieldMeta,
} from '@project-vault/shared'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

type Cursor = { systemName: string; dependencyId: string }

type ContextRow = {
  credential_id: string
  project_id: string
  credential_name: string
  rotation_schedule: string | null
  expires_at: Date | null
  cacheable: boolean
  version_number: number | null
  schema_version: number | null
  field_meta: unknown
  rotation_id: string | null
  rotation_status: string | null
  initiated_at: Date | null
  completed_at: Date | null
  target_fields: unknown
  dependency_count: string | number
  locations: unknown
}

function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Cursor>
    if (
      typeof parsed.systemName !== 'string' ||
      parsed.systemName.length === 0 ||
      typeof parsed.dependencyId !== 'string' ||
      parsed.dependencyId.length === 0
    )
      return null
    return { systemName: parsed.systemName, dependencyId: parsed.dependencyId }
  } catch {
    return null
  }
}

export const CredentialOperationalContextQuerySchema = z
  .object({
    // Fastify exposes query parameters as strings. Detailed cursor/limit validation remains in
    // parseOperationalContextQuery so the same parser also protects direct service callers.
    cursor: z.string().optional(),
    limit: z.string().optional(),
  })
  .passthrough()

const CredentialOperationalContextRuntimeQuerySchema =
  CredentialOperationalContextQuerySchema.strict()

function encodeCursor(
  location: { systemName: string; dependencyId: string } | undefined
): string | null {
  return location ? Buffer.from(JSON.stringify(location), 'utf8').toString('base64url') : null
}

function classifyCredentialType(schemaVersion: number | null, fieldMeta: FieldMeta[]) {
  if (schemaVersion === 1) return 'legacy' as const
  if (fieldMeta.length === 0 || fieldMeta.every((field) => field.template === undefined))
    return 'untemplated' as const
  const template = fieldMeta[0]?.template
  if (!template || template === 'custom' || fieldMeta.some((field) => field.template !== template))
    return 'custom' as const
  const canonical = CREDENTIAL_TEMPLATE_FIELDS[template as CredentialTemplate]
  const matches =
    canonical.length === fieldMeta.length &&
    canonical.every(
      (field, index) =>
        field.key === fieldMeta[index]?.key && field.sensitive === fieldMeta[index]?.sensitive
    )
  return matches ? template : ('custom' as const)
}

function parseFieldMeta(schemaVersion: number | null, raw: unknown): FieldMeta[] {
  if (schemaVersion === 1 || raw === null || raw === undefined) return []
  const parsed = FieldMetaSchema.array().max(MAX_FIELDS_PER_SECRET).safeParse(raw)
  if (!parsed.success) throw new Error('credential_operational_context_invalid_field_meta')
  return parsed.data
}

function parseTargetFields(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return null
  const parsed = FieldMetaSchema.shape.key.array().max(MAX_FIELDS_PER_SECRET).safeParse(raw)
  if (!parsed.success) throw new Error('credential_operational_context_invalid_target_fields')
  const seen = new Set<string>()
  for (const key of parsed.data) {
    const normalized = normalizeFieldKey(key)
    if (seen.has(normalized))
      throw new Error('credential_operational_context_invalid_target_fields')
    seen.add(normalized)
  }
  return parsed.data
}

export function parseOperationalContextQuery(
  query: unknown
): { ok: true; cursor: string | undefined; limit: number } | { ok: false } {
  const parsed = CredentialOperationalContextRuntimeQuerySchema.safeParse(query ?? {})
  if (!parsed.success) return { ok: false }
  const { cursor, limit } = parsed.data
  if (!isValidCursorInput(cursor)) return { ok: false }
  const parsedLimit = parseLimitInput(limit)
  return parsedLimit === null ? { ok: false } : { ok: true, cursor, limit: parsedLimit }
}

function isValidCursorInput(cursor: string | undefined): boolean {
  return (
    cursor === undefined ||
    (cursor.length > 0 && cursor.length <= 2048 && decodeCursor(cursor) !== null)
  )
}

function parseLimitInput(limit: string | undefined): number | null {
  const parsed = limit === undefined ? DEFAULT_LIMIT : Number(limit)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_LIMIT ? parsed : null
}

/** One SQL statement preserves a single PostgreSQL statement snapshot across every aggregate. */
export async function getCredentialOperationalContext(
  tx: Tx,
  input: { orgId: string; projectId: string; credentialId: string; cursor?: string; limit: number }
): Promise<CredentialOperationalContext | null> {
  const cursor = decodeCursor(input.cursor)
  const rows = await tx.execute<ContextRow>(sql`
    WITH selected_credential AS (
      SELECT c.id, c.org_id, c.project_id, c.name, c.rotation_schedule, c.expires_at, c.cacheable
      FROM credentials c
      WHERE c.id = ${input.credentialId} AND c.project_id = ${input.projectId} AND c.org_id = ${input.orgId}
    ), current_version AS (
      SELECT cv.* FROM credential_versions cv
      JOIN selected_credential c ON c.id = cv.credential_id AND c.org_id = cv.org_id
      WHERE cv.purged_at IS NULL AND cv.abandoned_at IS NULL AND cv.promoted_at IS NOT NULL
      ORDER BY cv.promoted_at DESC, cv.version_number DESC LIMIT 1
    ), latest_rotation AS (
      SELECT r.* FROM rotations r
      JOIN selected_credential c ON c.id = r.credential_id AND c.project_id = r.project_id AND c.org_id = r.org_id
      ORDER BY r.initiated_at DESC, r.id DESC LIMIT 1
    ), active_dependencies AS (
      SELECT d.id, d.system_name, d.system_type, d.field_key
      FROM credential_dependencies d
      JOIN selected_credential c ON c.id = d.credential_id AND c.org_id = d.org_id
      WHERE d.archived_at IS NULL
    ), page_dependencies AS (
      SELECT * FROM active_dependencies
      WHERE ${cursor?.systemName ?? null}::text IS NULL
        OR (system_name, id) > (${cursor?.systemName ?? null}::text, ${cursor?.dependencyId ?? null}::uuid)
      ORDER BY system_name ASC, id ASC
      LIMIT ${input.limit + 1}
    )
    SELECT
      c.id AS credential_id, c.project_id, c.name AS credential_name, c.rotation_schedule, c.expires_at, c.cacheable,
      cv.version_number, cv.schema_version, cv.field_meta,
      r.id AS rotation_id, r.status AS rotation_status, r.initiated_at, r.completed_at, r.target_fields,
      (SELECT count(*) FROM active_dependencies) AS dependency_count,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'dependencyId', id, 'systemName', system_name, 'systemType', system_type, 'fieldKey', field_key
      ) ORDER BY system_name ASC, id ASC) FROM page_dependencies), '[]'::jsonb) AS locations
    FROM selected_credential c
    LEFT JOIN current_version cv ON true
    LEFT JOIN latest_rotation r ON true
  `)
  const row = rows[0]
  if (!row) return null
  const fieldMeta = parseFieldMeta(row.schema_version, row.field_meta)
  const { items, more } = parseLocations(row.locations, input.limit)
  return CredentialOperationalContextSchema.parse(buildContextPayload(row, fieldMeta, items, more))
}

type Location = {
  dependencyId: string
  systemName: string
  systemType: string
  fieldKey: string | null
}

function parseLocations(raw: unknown, limit: number): { items: Location[]; more: boolean } {
  const locations = Array.isArray(raw) ? raw : []
  const items = locations.slice(0, limit) as Location[]
  return { items, more: locations.length > limit }
}

function serializeCurrentVersion(row: ContextRow) {
  if (row.version_number === null || row.schema_version === null) return null
  return { number: row.version_number, schemaVersion: row.schema_version }
}

function serializeRotation(row: ContextRow) {
  if (!row.rotation_id) {
    return {
      state: 'none' as const,
      id: null,
      initiatedAt: null,
      completedAt: null,
      targetFields: null,
    }
  }
  return {
    state: row.rotation_status,
    id: row.rotation_id,
    initiatedAt: row.initiated_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    targetFields: parseTargetFields(row.target_fields),
  }
}

function buildContextPayload(
  row: ContextRow,
  fieldMeta: FieldMeta[],
  items: Location[],
  more: boolean
) {
  return {
    contractVersion: 1,
    credential: {
      id: row.credential_id,
      projectId: row.project_id,
      name: row.credential_name,
      credentialType: classifyCredentialType(row.schema_version, fieldMeta),
      account: { status: 'not_available' as const, fieldKeys: fieldMeta.map((field) => field.key) },
      rotationSchedule: row.rotation_schedule,
      expiresAt: row.expires_at?.toISOString() ?? null,
      cacheable: row.cacheable,
      currentVersion: serializeCurrentVersion(row),
    },
    rotation: serializeRotation(row),
    usage: {
      activeDependencyCount: Number(row.dependency_count),
      locations: { items, nextCursor: more ? encodeCursor(items.at(-1)) : null },
    },
  }
}
