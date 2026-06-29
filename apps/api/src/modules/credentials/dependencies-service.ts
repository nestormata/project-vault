import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import {
  credentialDependencies,
  credentials,
  orgMemberships,
  users,
} from '@project-vault/db/schema'
import type {
  AddDependencyBody,
  ListDependenciesQuery,
  UpdateCredentialLifecycleBody,
} from './schema.js'
import { MAX_ACTIVE_DEPENDENCIES } from './schema.js'

export function serializeDependency(row: typeof credentialDependencies.$inferSelect) {
  return {
    id: row.id,
    credentialId: row.credentialId,
    systemName: row.systemName,
    systemType: row.systemType as 'service' | 'ci_pipeline' | 'database' | 'third_party' | 'other',
    notes: row.notes,
    createdBy: row.createdBy,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

async function credentialExistsInProject(
  tx: Tx,
  params: { credentialId: string; projectId: string }
): Promise<boolean> {
  const [cred] = await tx
    .select({ id: credentials.id })
    .from(credentials)
    .where(
      and(eq(credentials.id, params.credentialId), eq(credentials.projectId, params.projectId))
    )
    .limit(1)
  return Boolean(cred)
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
  const exists = await credentialExistsInProject(tx, {
    credentialId: input.credentialId,
    projectId: input.projectId,
  })
  if (!exists) return { status: 'not_found' as const }

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
      createdBy: input.userId,
    })
    .returning()
  if (!dependency) throw new Error('Dependency insert returned no row')

  return { status: 'created' as const, dependency: serializeDependency(dependency) }
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
  return {
    items: rows.map(serializeDependency),
    hasDependencies,
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
  if (!exists) return { status: 'not_found' as const }

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

  const [existing] = await tx
    .select({
      id: credentialDependencies.id,
      credentialId: credentialDependencies.credentialId,
      systemName: credentialDependencies.systemName,
      archivedAt: credentialDependencies.archivedAt,
    })
    .from(credentialDependencies)
    .where(
      and(
        eq(credentialDependencies.id, input.dependencyId),
        eq(credentialDependencies.credentialId, input.credentialId)
      )
    )
    .limit(1)

  if (!existing?.archivedAt) return { status: 'not_found' as const }

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
  const changed: Array<'expiresAt' | 'rotationSchedule'> = []

  if ('expiresAt' in rawBody) {
    changed.push('expiresAt')
    updates.expiresAt =
      body.expiresAt === null || body.expiresAt === undefined ? null : new Date(body.expiresAt)
  }
  if ('rotationSchedule' in rawBody) {
    changed.push('rotationSchedule')
    updates.rotationSchedule = body.rotationSchedule ?? null
  }

  return { updates, changed }
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

  const [updated] = await tx
    .update(credentials)
    .set(updates)
    .where(and(eq(credentials.id, input.credentialId), eq(credentials.projectId, input.projectId)))
    .returning({
      id: credentials.id,
      expiresAt: credentials.expiresAt,
      rotationSchedule: credentials.rotationSchedule,
      updatedAt: credentials.updatedAt,
    })

  if (!updated) return null

  return {
    data: {
      id: updated.id,
      expiresAt: updated.expiresAt?.toISOString() ?? null,
      rotationSchedule: updated.rotationSchedule,
      updatedAt: updated.updatedAt.toISOString(),
    },
    auditPayload: {
      changed,
      expiresAt: updated.expiresAt?.toISOString() ?? null,
      rotationSchedule: updated.rotationSchedule,
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
