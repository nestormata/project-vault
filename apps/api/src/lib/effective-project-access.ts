import { and, eq, isNull } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { projectMemberships, projects } from '@project-vault/db/schema'
import type {
  EffectiveProjectAccessGrantSource,
  EffectiveProjectAccessItem,
} from '@project-vault/extension-api'
import { resolveActiveOrgRoleInTx } from '../plugins/authenticate.js'
import type { OrgRole } from '../plugins/require-org-role.js'
import {
  grantSourceForProjectAccess,
  resolveEffectiveProjectRoleForOrgRole,
} from '../modules/projects/project-access.js'
import { isRecognizedOrgRole } from './authorization-role-check.js'

export const GROUP_GRANT_EVALUATION_NOT_EVALUATED = 'not_evaluated' as const

export type ListEffectiveProjectAccessInput = {
  orgId: string
  subjectUserId: string
  visibleProjectIds: 'all-active' | ReadonlySet<string>
}

export type ListEffectiveProjectAccessResult = {
  items: EffectiveProjectAccessItem[]
  groupGrantEvaluation: typeof GROUP_GRANT_EVALUATION_NOT_EVALUATED
}

function membershipRoleOf(raw: string | null): OrgRole | undefined {
  return raw && isRecognizedOrgRole(raw) ? raw : undefined
}

function isVisible(
  projectId: string,
  visibleProjectIds: ListEffectiveProjectAccessInput['visibleProjectIds']
): boolean {
  return visibleProjectIds === 'all-active' || visibleProjectIds.has(projectId)
}

function itemForRow(
  orgRole: OrgRole,
  projectId: string,
  membershipRole: OrgRole | undefined
): EffectiveProjectAccessItem | undefined {
  const grantSource: EffectiveProjectAccessGrantSource | null = grantSourceForProjectAccess({
    orgRole,
    membershipRole,
  })
  if (grantSource === null) return undefined
  return {
    projectId,
    effectiveRole: resolveEffectiveProjectRoleForOrgRole({ orgRole, membershipRole }),
    grantSource,
  }
}

/**
 * Story 73.6 — subject's effective access on active projects the caller may see.
 * Always loads the org's active project list (same query shape for a missing user and a
 * member with no rows). Classification groups stay `not_evaluated` until DW-459.
 */
export async function listEffectiveProjectAccess(
  tx: Tx,
  input: ListEffectiveProjectAccessInput
): Promise<ListEffectiveProjectAccessResult> {
  const [orgRole, rows] = await Promise.all([
    resolveActiveOrgRoleInTx(tx, input.subjectUserId, input.orgId),
    tx
      .select({
        projectId: projects.id,
        membershipRole: projectMemberships.role,
      })
      .from(projects)
      .leftJoin(
        projectMemberships,
        and(
          eq(projectMemberships.projectId, projects.id),
          eq(projectMemberships.userId, input.subjectUserId)
        )
      )
      .where(
        and(
          eq(projects.orgId, input.orgId),
          isNull(projects.deletedAt),
          isNull(projects.archivedAt)
        )
      ),
  ])

  const empty: ListEffectiveProjectAccessResult = {
    items: [],
    groupGrantEvaluation: GROUP_GRANT_EVALUATION_NOT_EVALUATED,
  }
  if (orgRole === null) return empty

  const items: EffectiveProjectAccessItem[] = []
  for (const row of rows) {
    if (!isVisible(row.projectId, input.visibleProjectIds)) continue
    const item = itemForRow(orgRole, row.projectId, membershipRoleOf(row.membershipRole))
    if (item) items.push(item)
  }
  items.sort((left, right) => left.projectId.localeCompare(right.projectId))
  return { items, groupGrantEvaluation: GROUP_GRANT_EVALUATION_NOT_EVALUATED }
}

export async function callerVisibleProjectIds(
  tx: Tx,
  input: { orgId: string; callerUserId: string }
): Promise<'all-active' | ReadonlySet<string>> {
  const callerRole = await resolveActiveOrgRoleInTx(tx, input.callerUserId, input.orgId)
  if (callerRole === 'owner' || callerRole === 'admin') return 'all-active'
  if (callerRole === null) return new Set()
  const rows = await tx
    .select({ projectId: projectMemberships.projectId })
    .from(projectMemberships)
    .innerJoin(projects, eq(projects.id, projectMemberships.projectId))
    .where(
      and(
        eq(projectMemberships.orgId, input.orgId),
        eq(projectMemberships.userId, input.callerUserId),
        isNull(projects.deletedAt),
        isNull(projects.archivedAt)
      )
    )
  return new Set(rows.map((row) => row.projectId))
}
