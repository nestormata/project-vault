import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { SystemTypeSchema } from '@project-vault/shared'
import {
  credentialDependencies,
  credentials,
  orgMemberships,
  rotationChecklistItems,
  rotations,
  users,
} from '@project-vault/db/schema'
import type {
  AddDependencyBody,
  ListDependenciesQuery,
  UpdateCredentialLifecycleBody,
} from './schema.js'
import { MAX_ACTIVE_DEPENDENCIES } from './schema.js'
import { credentialExistsInProject, lockCredentialInProject } from './db-helpers.js'

export function serializeDependency(row: typeof credentialDependencies.$inferSelect) {
  const systemType = SystemTypeSchema.safeParse(row.systemType)
  if (!systemType.success) {
    throw new Error(`invalid credential dependency systemType: ${row.systemType}`)
  }
  return {
    id: row.id,
    credentialId: row.credentialId,
    systemName: row.systemName,
    systemType: systemType.data,
    notes: row.notes,
    linkUrl: row.linkUrl,
    createdBy: row.createdBy,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** Shared by archiveCredentialDependency's post-idempotency-check lookup and
 *  updateCredentialDependencyLink's pre-UPDATE read — both need the full current row for a
 *  dependency scoped to its parent credential, regardless of archive state.
 *
 *  `forUpdate` row-locks the dependency (mirroring `db-helpers.ts`'s `lockCredentialInProject`
 *  pattern) — required by updateCredentialDependencyLink's "before" read so that two concurrent
 *  PATCHes on the same dependency can't both read the same pre-change `linkUrl` and each commit
 *  an audit payload whose `previousLinkUrl` no longer matches what was actually live at commit
 *  time (code review finding, 2-10). archiveCredentialDependency's lookup runs after its own
 *  UPDATE already applied, so it never needs the lock. */
async function findDependencyByIdInCredential(
  tx: Tx,
  params: { dependencyId: string; credentialId: string },
  opts: { forUpdate?: boolean } = {}
): Promise<typeof credentialDependencies.$inferSelect | undefined> {
  const query = tx
    .select()
    .from(credentialDependencies)
    .where(
      and(
        eq(credentialDependencies.id, params.dependencyId),
        eq(credentialDependencies.credentialId, params.credentialId)
      )
    )
  const [row] = await (opts.forUpdate ? query.for('update') : query).limit(1)
  return row
}

async function hasActiveDependencies(tx: Tx, credentialId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: credentialDependencies.id })
    .from(credentialDependencies)
    .where(
      and(
        eq(credentialDependencies.credentialId, credentialId),
        isNull(credentialDependencies.archivedAt)
      )
    )
    .limit(1)
  return Boolean(row)
}

export async function addCredentialDependency(
  tx: Tx,
  input: {
    orgId: string
    userId: string
    credentialId: string
    projectId: string
    body: AddDependencyBody
  }
) {
  const locked = await lockCredentialInProject(tx, {
    credentialId: input.credentialId,
    projectId: input.projectId,
  })
  if (!locked) return { status: 'not_found' as const }

  const countResult = await tx
    .select({ count: sql<number>`count(*)` })
    .from(credentialDependencies)
    .where(
      and(
        eq(credentialDependencies.credentialId, input.credentialId),
        isNull(credentialDependencies.archivedAt)
      )
    )
  const count = Number(countResult[0]?.count ?? 0)
  if (count >= MAX_ACTIVE_DEPENDENCIES) {
    return { status: 'too_many' as const }
  }

  const [dependency] = await tx
    .insert(credentialDependencies)
    .values({
      orgId: input.orgId,
      credentialId: input.credentialId,
      systemName: input.body.systemName,
      systemType: input.body.systemType ?? 'other',
      notes: input.body.notes ?? null,
      linkUrl: input.body.linkUrl ?? null,
      createdBy: input.userId,
    })
    .returning()
  if (!dependency) throw new Error('Dependency insert returned no row')

  return { status: 'created' as const, dependency: serializeDependency(dependency) }
}

export type DependencyChecklistStatus = {
  rotationId: string
  itemId: string
  status: string
  confirmedBy: string | null
  confirmedAt: string | null
}

/** AC-5: finds the credential's currently-`staged` rotation (at most one, per the widened
 *  idx_rotations_one_active_per_credential unique index — Story 5.6 AC-2.6) and, if found, the
 *  checklist items belonging to it, keyed by dependencyId. Returns `hasStagedRotation: false` and
 *  an empty map when no rotation is currently staged — this authoritative flag (not client-side
 *  inference) is what AC-6's UI uses to distinguish "no rotation in progress" from "dependency
 *  added after this rotation started" (ADR-2.10-02). */
async function findStagedChecklistStatusByDependency(
  tx: Tx,
  credentialId: string
): Promise<{ hasStagedRotation: boolean; byDependencyId: Map<string, DependencyChecklistStatus> }> {
  const [stagedRotation] = await tx
    .select({ id: rotations.id })
    .from(rotations)
    .where(and(eq(rotations.credentialId, credentialId), eq(rotations.status, 'staged')))
    .limit(1)

  if (!stagedRotation) return { hasStagedRotation: false, byDependencyId: new Map() }

  const items = await tx
    .select({
      id: rotationChecklistItems.id,
      dependencyId: rotationChecklistItems.dependencyId,
      status: rotationChecklistItems.status,
      confirmedBy: rotationChecklistItems.confirmedBy,
      confirmedAt: rotationChecklistItems.confirmedAt,
    })
    .from(rotationChecklistItems)
    .where(eq(rotationChecklistItems.rotationId, stagedRotation.id))

  const byDependencyId = new Map<string, DependencyChecklistStatus>()
  for (const item of items) {
    // Story 5.1 AC-1: dependencyId is nullable (FK is 'set null' on delete) — a checklist item
    // with no surviving dependencyId can never match a list row, so it's simply skipped here.
    if (!item.dependencyId) continue
    byDependencyId.set(item.dependencyId, {
      rotationId: stagedRotation.id,
      itemId: item.id,
      status: item.status,
      confirmedBy: item.confirmedBy,
      confirmedAt: item.confirmedAt?.toISOString() ?? null,
    })
  }

  return { hasStagedRotation: true, byDependencyId }
}

export async function listCredentialDependencies(
  tx: Tx,
  input: {
    credentialId: string
    projectId: string
    query: ListDependenciesQuery
  }
) {
  const exists = await credentialExistsInProject(tx, {
    credentialId: input.credentialId,
    projectId: input.projectId,
  })
  if (!exists) return null

  const filters = [eq(credentialDependencies.credentialId, input.credentialId)]
  if (!input.query.includeArchived) {
    filters.push(isNull(credentialDependencies.archivedAt))
  }

  const rows = await tx
    .select()
    .from(credentialDependencies)
    .where(and(...filters))
    .orderBy(desc(credentialDependencies.createdAt), desc(credentialDependencies.id))

  const hasDependencies = await hasActiveDependencies(tx, input.credentialId)
  const { hasStagedRotation, byDependencyId } = await findStagedChecklistStatusByDependency(
    tx,
    input.credentialId
  )

  return {
    items: rows.map((row) => ({
      ...serializeDependency(row),
      checklistStatus: byDependencyId.get(row.id) ?? null,
    })),
    hasDependencies,
    hasStagedRotation,
  }
}

/** AC-3.2/3.4 — narrowly scoped to `linkUrl` only. Absent/value/null three-state semantics are
 *  resolved by the caller (route handler) via the raw request body's `in` check; this function
 *  always receives an already-decided `linkUrl` value to write. Example 3c: a 0-row UPDATE result
 *  (archived-or-missing) is disambiguated by a follow-up existence check, mirroring the archive
 *  route's own idempotency-guard pattern in reverse — an archived row and a truly-absent row both
 *  return `dependency_not_found` (no caller-visible distinction, Story 2.4 AC-5 precedent). */
export async function updateCredentialDependencyLink(
  tx: Tx,
  input: {
    credentialId: string
    projectId: string
    dependencyId: string
    linkUrl: string | null
  }
) {
  const exists = await credentialExistsInProject(tx, {
    credentialId: input.credentialId,
    projectId: input.projectId,
  })
  if (!exists) return { status: 'credential_not_found' as const }

  // Security Audit Persona (Auditor) finding, Round 3: read the row's current linkUrl inside the
  // same transaction as the UPDATE so the audit payload can carry a before/after diff — a URL
  // field's history matters for forensic review in a way a single "new value" doesn't.
  const before = await findDependencyByIdInCredential(
    tx,
    {
      dependencyId: input.dependencyId,
      credentialId: input.credentialId,
    },
    { forUpdate: true }
  )

  // Example 3c: an archived (or truly missing) dependency is not editable — both resolve to the
  // same caller-visible `dependency_not_found`, no distinct code.
  if (!before || before.archivedAt !== null) return { status: 'dependency_not_found' as const }

  const [updated] = await tx
    .update(credentialDependencies)
    .set({ linkUrl: input.linkUrl })
    .where(
      and(
        eq(credentialDependencies.id, input.dependencyId),
        eq(credentialDependencies.credentialId, input.credentialId),
        isNull(credentialDependencies.archivedAt)
      )
    )
    .returning({
      id: credentialDependencies.id,
      linkUrl: credentialDependencies.linkUrl,
      updatedAt: credentialDependencies.updatedAt,
    })

  if (!updated) return { status: 'dependency_not_found' as const }

  return {
    status: 'updated' as const,
    data: {
      id: updated.id,
      linkUrl: updated.linkUrl,
      updatedAt: updated.updatedAt.toISOString(),
    },
    auditPayload: {
      dependencyId: updated.id,
      linkUrl: updated.linkUrl,
      previousLinkUrl: before.linkUrl,
    },
  }
}

export async function archiveCredentialDependency(
  tx: Tx,
  input: {
    userId: string
    credentialId: string
    projectId: string
    dependencyId: string
  }
) {
  const exists = await credentialExistsInProject(tx, {
    credentialId: input.credentialId,
    projectId: input.projectId,
  })
  if (!exists) return { status: 'credential_not_found' as const }

  const [archived] = await tx
    .update(credentialDependencies)
    .set({ archivedAt: new Date(), archivedBy: input.userId })
    .where(
      and(
        eq(credentialDependencies.id, input.dependencyId),
        eq(credentialDependencies.credentialId, input.credentialId),
        isNull(credentialDependencies.archivedAt)
      )
    )
    .returning({
      id: credentialDependencies.id,
      credentialId: credentialDependencies.credentialId,
      systemName: credentialDependencies.systemName,
      archivedAt: credentialDependencies.archivedAt,
    })

  if (archived?.archivedAt) {
    return {
      status: 'archived' as const,
      data: {
        id: archived.id,
        credentialId: archived.credentialId,
        archivedAt: archived.archivedAt.toISOString(),
      },
      auditPayload: { dependencyId: archived.id, systemName: archived.systemName },
    }
  }

  const existing = await findDependencyByIdInCredential(tx, {
    dependencyId: input.dependencyId,
    credentialId: input.credentialId,
  })

  if (!existing?.archivedAt) return { status: 'dependency_not_found' as const }

  return {
    status: 'already_archived' as const,
    data: {
      id: existing.id,
      credentialId: existing.credentialId,
      archivedAt: existing.archivedAt.toISOString(),
    },
    auditPayload: { dependencyId: existing.id, systemName: existing.systemName },
  }
}

function buildLifecyclePatch(
  rawBody: Record<string, unknown>,
  body: UpdateCredentialLifecycleBody
) {
  const updates: Partial<typeof credentials.$inferInsert> = {}
  const changed: Array<'expiresAt' | 'rotationSchedule' | 'cacheable'> = []

  if ('expiresAt' in rawBody) {
    changed.push('expiresAt')
    updates.expiresAt =
      body.expiresAt === null || body.expiresAt === undefined ? null : new Date(body.expiresAt)
  }
  if ('rotationSchedule' in rawBody) {
    changed.push('rotationSchedule')
    updates.rotationSchedule = body.rotationSchedule ?? null
  }
  if ('cacheable' in rawBody) {
    changed.push('cacheable')
    updates.cacheable = body.cacheable ?? true
  }

  return { updates, changed }
}

function expiresAtEqual(next: Date | null | undefined, prev: Date | null): boolean {
  return (next?.getTime() ?? null) === (prev?.getTime() ?? null)
}

function lifecycleValuesEqual(
  existing: {
    expiresAt: Date | null
    rotationSchedule: string | null
    cacheable: boolean
  },
  updates: Partial<typeof credentials.$inferInsert>
): boolean {
  if ('expiresAt' in updates && !expiresAtEqual(updates.expiresAt, existing.expiresAt)) {
    return false
  }
  if (
    'rotationSchedule' in updates &&
    (updates.rotationSchedule ?? null) !== existing.rotationSchedule
  ) {
    return false
  }
  if ('cacheable' in updates && updates.cacheable !== existing.cacheable) {
    return false
  }
  return true
}

export async function updateCredentialLifecycle(
  tx: Tx,
  input: {
    credentialId: string
    projectId: string
    body: UpdateCredentialLifecycleBody
    rawBody: Record<string, unknown>
  }
) {
  const { updates, changed } = buildLifecyclePatch(input.rawBody, input.body)

  const [existing] = await tx
    .select({
      id: credentials.id,
      expiresAt: credentials.expiresAt,
      rotationSchedule: credentials.rotationSchedule,
      cacheable: credentials.cacheable,
      updatedAt: credentials.updatedAt,
    })
    .from(credentials)
    .where(and(eq(credentials.id, input.credentialId), eq(credentials.projectId, input.projectId)))
    .limit(1)

  if (!existing) return null

  if (lifecycleValuesEqual(existing, updates)) {
    return {
      status: 'unchanged' as const,
      data: {
        id: existing.id,
        expiresAt: existing.expiresAt?.toISOString() ?? null,
        rotationSchedule: existing.rotationSchedule,
        cacheable: existing.cacheable,
        updatedAt: existing.updatedAt.toISOString(),
      },
    }
  }

  const [updated] = await tx
    .update(credentials)
    .set(updates)
    .where(and(eq(credentials.id, input.credentialId), eq(credentials.projectId, input.projectId)))
    .returning({
      id: credentials.id,
      expiresAt: credentials.expiresAt,
      rotationSchedule: credentials.rotationSchedule,
      cacheable: credentials.cacheable,
      updatedAt: credentials.updatedAt,
    })

  if (!updated) return null

  return {
    status: 'updated' as const,
    data: {
      id: updated.id,
      expiresAt: updated.expiresAt?.toISOString() ?? null,
      rotationSchedule: updated.rotationSchedule,
      cacheable: updated.cacheable,
      updatedAt: updated.updatedAt.toISOString(),
    },
    auditPayload: {
      changed,
      expiresAt: updated.expiresAt?.toISOString() ?? null,
      rotationSchedule: updated.rotationSchedule,
      cacheable: updated.cacheable,
    },
  }
}

export async function listCredentialAccess(
  tx: Tx,
  input: { credentialId: string; projectId: string; orgId: string }
) {
  const exists = await credentialExistsInProject(tx, {
    credentialId: input.credentialId,
    projectId: input.projectId,
  })
  if (!exists) return null

  const rows = await tx
    .select({
      displayName: users.email,
      role: orgMemberships.role,
      grantedAt: orgMemberships.createdAt,
    })
    .from(orgMemberships)
    .innerJoin(users, eq(users.id, orgMemberships.userId))
    .where(and(eq(orgMemberships.orgId, input.orgId), eq(orgMemberships.status, 'active')))
    .orderBy(desc(orgMemberships.createdAt))

  return rows.map((row) => ({
    identityType: 'user' as const,
    displayName: row.displayName,
    role: row.role as 'owner' | 'admin' | 'member' | 'viewer',
    grantedAt: row.grantedAt.toISOString(),
  }))
}
