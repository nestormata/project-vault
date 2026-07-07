import { and, asc, eq, inArray, lte } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import {
  auditLogEntries,
  organizations,
  orgMemberships,
  projectInvitations,
  projectMemberships,
  projects,
  userIdentityTokens,
  users,
} from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'
import { toCsvRow } from './csv.js'
import type { AccessReportUser } from './access-report-schema.js'

export class InvalidAsOfError extends Error {
  readonly code = 'invalid_as_of'
  constructor(message: string) {
    super(message)
    this.name = 'InvalidAsOfError'
  }
}

// D2 item 2 — the exact event-type set the historical-replay path scans. Every entry here is
// confirmed (grep-verified, cited by file/line in the story's D2 section) to carry the
// resourceId/payload shape this replay algorithm assumes.
const REPLAY_EVENT_TYPES = [
  AuditEvent.USER_REGISTERED,
  AuditEvent.PROJECT_INVITATION_ACCEPTED,
  AuditEvent.PROJECT_MEMBER_ROLE_CHANGED,
  AuditEvent.PROJECT_MEMBER_REMOVED,
  AuditEvent.PROJECT_OWNERSHIP_TRANSFERRED,
  AuditEvent.ORG_USER_REMOVED,
  AuditEvent.ORG_USER_DEACTIVATED,
] as const

type OrgState = { orgRole: string; status: 'active' | 'deactivated' }
type ProjectState = { role: string; grantedAt: Date }

function projectStateKey(userId: string, projectId: string): string {
  return `${userId}:${projectId}`
}

/**
 * D4 — displayName is ALWAYS resolved via the current-state user_identity_tokens row (never
 * users.email), for both the fast path and the historical path, regardless of `asOf`. "First
 * created wins", the same convention firstActorTokenIdForUser() already uses, so a user with
 * multiple identity-token rows (AC-17's edge case) resolves consistently everywhere.
 */
async function fetchDisplayNames(tx: Tx, userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map()
  const rows = await tx
    .select({ userId: userIdentityTokens.userId, displayName: userIdentityTokens.displayName })
    .from(userIdentityTokens)
    .where(inArray(userIdentityTokens.userId, userIds))
    .orderBy(asc(userIdentityTokens.createdAt), asc(userIdentityTokens.id))
  const map = new Map<string, string>()
  for (const row of rows) {
    if (row.userId && !map.has(row.userId)) map.set(row.userId, row.displayName)
  }
  return map
}

async function fetchProjectNames(tx: Tx, projectIds: string[]): Promise<Map<string, string>> {
  if (projectIds.length === 0) return new Map()
  const rows = await tx
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(inArray(projects.id, projectIds))
  return new Map(rows.map((row) => [row.id, row.name]))
}

/** D2 item 1 (fast path) — current-state `org_memberships`/`project_memberships` are correct by
 * definition for "now"; this is the only path where a hard-deleted (removed) user is correctly
 * absent (they no longer have any row to read). */
async function computeFastPathUsers(tx: Tx, orgId: string): Promise<AccessReportUser[]> {
  const memberships = await tx
    .select({
      userId: orgMemberships.userId,
      orgRole: orgMemberships.role,
      status: orgMemberships.status,
    })
    .from(orgMemberships)
    .where(eq(orgMemberships.orgId, orgId))

  const projectRows = await tx
    .select({
      userId: projectMemberships.userId,
      projectId: projectMemberships.projectId,
      projectName: projects.name,
      role: projectMemberships.role,
      grantedAt: projectMemberships.createdAt,
    })
    .from(projectMemberships)
    .innerJoin(projects, eq(projects.id, projectMemberships.projectId))
    .where(eq(projectMemberships.orgId, orgId))

  const displayNameByUserId = await fetchDisplayNames(
    tx,
    memberships.map((m) => m.userId)
  )

  const projectsByUser = new Map<string, AccessReportUser['projects']>()
  for (const row of projectRows) {
    const list = projectsByUser.get(row.userId) ?? []
    list.push({
      projectId: row.projectId,
      projectName: row.projectName,
      role: row.role as AccessReportUser['orgRole'],
      grantedAt: row.grantedAt.toISOString(),
    })
    projectsByUser.set(row.userId, list)
  }

  const users = memberships.map((m) => ({
    userId: m.userId,
    displayName: displayNameByUserId.get(m.userId) ?? '',
    orgRole: m.orgRole as AccessReportUser['orgRole'],
    status: m.status as AccessReportUser['status'],
    projects: projectsByUser.get(m.userId) ?? [],
  }))
  users.sort((a, b) => a.userId.localeCompare(b.userId))
  return users
}

type ReplayRow = {
  eventType: string
  resourceId: string | null
  payload: unknown
  createdAt: Date
  actorUserId: string | null
}

type InvitationRow = {
  id: string
  projectId: string
  email: string
  roleToAssign: string
  acceptedAt: Date | null
}

/** The existing-user-accepts-invitation emission shape (`invitations/token-routes.ts`): the
 * granted role is resolved by a direct id join, since `resourceId` IS the invitation id. */
function resolveInvitationRoleByResourceId(
  resourceId: string,
  invitationById: Map<string, InvitationRow>
): string | undefined {
  return invitationById.get(resourceId)?.roleToAssign
}

/** The registration-via-invitation emission shape (`auth/service.ts`): no `resourceId`, so the
 * granted role is resolved by the unique-at-claim-time `(projectId, email)` combination,
 * disambiguated to the invitation whose `acceptedAt` is nearest this event's own `createdAt` — a
 * user who was invited to the same project more than once over its history resolves to the
 * specific invitation this acceptance event actually claimed. */
function resolveInvitationRoleByProjectEmail(
  row: ReplayRow,
  projectId: string,
  email: string,
  invitationsByProjectEmail: Map<string, InvitationRow[]>
): string | undefined {
  const candidates = invitationsByProjectEmail.get(`${projectId}:${email}`) ?? []
  let best: InvitationRow | undefined
  let bestDelta = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    if (!candidate.acceptedAt) continue
    const delta = Math.abs(candidate.acceptedAt.getTime() - row.createdAt.getTime())
    if (delta < bestDelta) {
      bestDelta = delta
      best = candidate
    }
  }
  return best?.roleToAssign
}

/** D2 item 2's `project.invitation_accepted` role resolution — the granted project role is never
 * present in either emission site's payload, so it must be resolved by joining to
 * `project_invitations.roleToAssign`, via one of the two strategies above depending on whether
 * `resourceId` is present. */
function resolveInvitationRole(
  row: ReplayRow,
  payload: Record<string, unknown>,
  invitationById: Map<string, InvitationRow>,
  invitationsByProjectEmail: Map<string, InvitationRow[]>,
  emailByUserId: Map<string, string>
): string | undefined {
  if (row.resourceId) {
    return resolveInvitationRoleByResourceId(row.resourceId, invitationById)
  }
  const email = row.actorUserId ? emailByUserId.get(row.actorUserId) : undefined
  const projectId = payload['projectId']
  if (!email || typeof projectId !== 'string') return undefined
  return resolveInvitationRoleByProjectEmail(row, projectId, email, invitationsByProjectEmail)
}

async function fetchProjectInvitations(tx: Tx, orgId: string): Promise<InvitationRow[]> {
  return tx
    .select({
      id: projectInvitations.id,
      projectId: projectInvitations.projectId,
      email: projectInvitations.email,
      roleToAssign: projectInvitations.roleToAssign,
      acceptedAt: projectInvitations.acceptedAt,
    })
    .from(projectInvitations)
    .where(eq(projectInvitations.orgId, orgId))
}

async function fetchUserEmails(tx: Tx, userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map()
  const rows = await tx
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(inArray(users.id, userIds))
  return new Map(rows.map((row) => [row.id, row.email]))
}

type ReplayState = { orgState: Map<string, OrgState>; projectState: Map<string, ProjectState> }
type InvitationLookups = {
  invitationById: Map<string, InvitationRow>
  invitationsByProjectEmail: Map<string, InvitationRow[]>
  emailByUserId: Map<string, string>
}

/** `user.registered` — the founding-owner org-membership-creation event (finding-1's fix): the
 * subject is the row's own actor (a self-registration), never previously seen for this org. */
function applyUserRegistered(row: ReplayRow, state: ReplayState): void {
  if (row.actorUserId && !state.orgState.has(row.actorUserId)) {
    state.orgState.set(row.actorUserId, { orgRole: 'owner', status: 'active' })
  }
}

/** `project.invitation_accepted` — both an org-membership-creation event (role 'member', only
 * when this is the user's first-seen membership in this org) AND a project-membership grant. */
function applyProjectInvitationAccepted(
  row: ReplayRow,
  payload: Record<string, unknown>,
  state: ReplayState,
  lookups: InvitationLookups
): void {
  if (!row.actorUserId) return
  if (!state.orgState.has(row.actorUserId)) {
    state.orgState.set(row.actorUserId, { orgRole: 'member', status: 'active' })
  }
  const projectId = payload['projectId']
  const role = resolveInvitationRole(
    row,
    payload,
    lookups.invitationById,
    lookups.invitationsByProjectEmail,
    lookups.emailByUserId
  )
  if (typeof projectId === 'string' && role) {
    state.projectState.set(projectStateKey(row.actorUserId, projectId), {
      role,
      grantedAt: row.createdAt,
    })
  }
}

/** `project.member_role_changed` — role changes to `payload.newRole` from this event onward. */
function applyProjectMemberRoleChanged(
  row: ReplayRow,
  payload: Record<string, unknown>,
  state: ReplayState
): void {
  const userId = row.resourceId
  const projectId = payload['projectId']
  const newRole = payload['newRole']
  if (userId && typeof projectId === 'string' && typeof newRole === 'string') {
    state.projectState.set(projectStateKey(userId, projectId), {
      role: newRole,
      grantedAt: row.createdAt,
    })
  }
}

/** `project.member_removed` — the (userId, projectId) triple's membership ends at this event. */
function applyProjectMemberRemoved(
  row: ReplayRow,
  payload: Record<string, unknown>,
  state: ReplayState
): void {
  const userId = row.resourceId
  const projectId = payload['projectId']
  if (userId && typeof projectId === 'string') {
    state.projectState.delete(projectStateKey(userId, projectId))
  }
}

/** `project.ownership_transferred` — derives two state transitions from one event: the previous
 * owner demotes to 'admin', the new owner promotes to 'owner' (D2 — never a removal). */
function applyProjectOwnershipTransferred(
  row: ReplayRow,
  payload: Record<string, unknown>,
  state: ReplayState
): void {
  const projectId = row.resourceId
  const previousOwnerId = payload['previousOwnerId']
  const newOwnerId = payload['newOwnerId']
  if (projectId && typeof previousOwnerId === 'string') {
    state.projectState.set(projectStateKey(previousOwnerId, projectId), {
      role: 'admin',
      grantedAt: row.createdAt,
    })
  }
  if (projectId && typeof newOwnerId === 'string') {
    state.projectState.set(projectStateKey(newOwnerId, projectId), {
      role: 'owner',
      grantedAt: row.createdAt,
    })
  }
}

/** `org.user_removed` — cascades: every project membership for this user in the org ends, and
 * the user drops out of the report entirely from this event onward. */
function applyOrgUserRemoved(row: ReplayRow, state: ReplayState): void {
  const userId = row.resourceId
  if (!userId) return
  state.orgState.delete(userId)
  for (const key of [...state.projectState.keys()]) {
    if (key.startsWith(`${userId}:`)) state.projectState.delete(key)
  }
}

/** `org.user_deactivated` — status becomes 'deactivated' but the user remains in the report. */
function applyOrgUserDeactivated(row: ReplayRow, state: ReplayState): void {
  const userId = row.resourceId
  const existing = userId ? state.orgState.get(userId) : undefined
  if (existing) existing.status = 'deactivated'
}

/** Dispatches a single replay row to its event-specific state-transition handler above — kept as
 * a flat dispatch table (not a switch) so this function's own cyclomatic/cognitive complexity
 * stays low; all the actual branching lives in each handler, scoped to one event type at a time. */
function applyReplayRow(row: ReplayRow, state: ReplayState, lookups: InvitationLookups): void {
  const payload = (row.payload ?? {}) as Record<string, unknown>
  const handlers: Record<string, () => void> = {
    [AuditEvent.USER_REGISTERED]: () => applyUserRegistered(row, state),
    [AuditEvent.PROJECT_INVITATION_ACCEPTED]: () =>
      applyProjectInvitationAccepted(row, payload, state, lookups),
    [AuditEvent.PROJECT_MEMBER_ROLE_CHANGED]: () =>
      applyProjectMemberRoleChanged(row, payload, state),
    [AuditEvent.PROJECT_MEMBER_REMOVED]: () => applyProjectMemberRemoved(row, payload, state),
    [AuditEvent.PROJECT_OWNERSHIP_TRANSFERRED]: () =>
      applyProjectOwnershipTransferred(row, payload, state),
    [AuditEvent.ORG_USER_REMOVED]: () => applyOrgUserRemoved(row, state),
    [AuditEvent.ORG_USER_DEACTIVATED]: () => applyOrgUserDeactivated(row, state),
  }
  handlers[row.eventType]?.()
}

async function fetchReplayRows(tx: Tx, orgId: string, asOf: Date): Promise<ReplayRow[]> {
  return (await tx
    .select({
      eventType: auditLogEntries.eventType,
      resourceId: auditLogEntries.resourceId,
      payload: auditLogEntries.payload,
      createdAt: auditLogEntries.createdAt,
      actorUserId: userIdentityTokens.userId,
    })
    .from(auditLogEntries)
    .leftJoin(userIdentityTokens, eq(userIdentityTokens.id, auditLogEntries.actorTokenId))
    .where(
      and(
        eq(auditLogEntries.orgId, orgId),
        inArray(auditLogEntries.eventType, [...REPLAY_EVENT_TYPES]),
        lte(auditLogEntries.createdAt, asOf)
      )
    )
    .orderBy(asc(auditLogEntries.createdAt))) as ReplayRow[]
}

async function buildInvitationLookups(
  tx: Tx,
  orgId: string,
  rows: ReplayRow[]
): Promise<InvitationLookups> {
  const emailLookupUserIds = new Set<string>()
  for (const row of rows) {
    if (
      row.eventType === AuditEvent.PROJECT_INVITATION_ACCEPTED &&
      !row.resourceId &&
      row.actorUserId
    ) {
      emailLookupUserIds.add(row.actorUserId)
    }
  }
  const [emailByUserId, invitations] = await Promise.all([
    fetchUserEmails(tx, [...emailLookupUserIds]),
    fetchProjectInvitations(tx, orgId),
  ])
  const invitationById = new Map(invitations.map((inv) => [inv.id, inv]))
  const invitationsByProjectEmail = new Map<string, InvitationRow[]>()
  for (const inv of invitations) {
    const key = `${inv.projectId}:${inv.email}`
    const list = invitationsByProjectEmail.get(key) ?? []
    list.push(inv)
    invitationsByProjectEmail.set(key, list)
  }
  return { invitationById, invitationsByProjectEmail, emailByUserId }
}

/**
 * D2 item 2 — event-replay reconstruction: scans `audit_log_entries` for the confirmed
 * membership-mutation event set, ordered ascending up to and including `asOf`, and derives
 * per-`(userId, projectId)` state transitions plus per-user org-membership state. Returns raw
 * state maps (not yet paginated/displayName-resolved) so the caller can layer D4's always-
 * current-state displayName resolution on top, identically to the fast path.
 */
async function replayAccessAsOf(tx: Tx, orgId: string, asOf: Date): Promise<ReplayState> {
  const rows = await fetchReplayRows(tx, orgId, asOf)
  const lookups = await buildInvitationLookups(tx, orgId, rows)

  const state: ReplayState = { orgState: new Map(), projectState: new Map() }
  for (const row of rows) {
    applyReplayRow(row, state, lookups)
  }
  return state
}

async function buildUsersFromState(
  tx: Tx,
  orgState: Map<string, OrgState>,
  projectState: Map<string, ProjectState>
): Promise<AccessReportUser[]> {
  const projectIds = new Set<string>()
  for (const key of projectState.keys()) {
    const projectId = key.slice(key.indexOf(':') + 1)
    projectIds.add(projectId)
  }
  const [projectNameById, displayNameByUserId] = await Promise.all([
    fetchProjectNames(tx, [...projectIds]),
    fetchDisplayNames(tx, [...orgState.keys()]),
  ])

  const users: AccessReportUser[] = []
  for (const [userId, state] of orgState) {
    const userProjects: AccessReportUser['projects'] = []
    for (const [key, pState] of projectState) {
      if (!key.startsWith(`${userId}:`)) continue
      const projectId = key.slice(key.indexOf(':') + 1)
      userProjects.push({
        projectId,
        projectName: projectNameById.get(projectId) ?? '',
        role: pState.role as AccessReportUser['orgRole'],
        grantedAt: pState.grantedAt.toISOString(),
      })
    }
    userProjects.sort((a, b) => a.projectId.localeCompare(b.projectId))
    users.push({
      userId,
      displayName: displayNameByUserId.get(userId) ?? '',
      orgRole: state.orgRole as AccessReportUser['orgRole'],
      status: state.status,
      projects: userProjects,
    })
  }
  users.sort((a, b) => a.userId.localeCompare(b.userId))
  return users
}

export type AccessReportResult = {
  users: AccessReportUser[]
  asOf: string
}

/**
 * D2 — top-level entry point: `asOf` absent → fast path (AC-1); `asOf` present, at any valid
 * timestamp → historical/replay path (AC-2), never based on comparing it to "now" (resolves
 * finding-8's fast/historical boundary ambiguity). Validates `asOf` isn't in the future and
 * doesn't predate the org (AC-5) before running the (potentially expensive) replay.
 */
export async function buildAccessReport(
  tx: Tx,
  params: { orgId: string; asOf?: string }
): Promise<AccessReportResult> {
  if (params.asOf === undefined) {
    const reportUsers = await computeFastPathUsers(tx, params.orgId)
    return { users: reportUsers, asOf: new Date().toISOString() }
  }

  const [org] = await tx
    .select({ createdAt: organizations.createdAt })
    .from(organizations)
    .where(eq(organizations.id, params.orgId))
    .limit(1)
  if (!org) throw new Error('buildAccessReport: organization not found for scoped orgId')

  const asOfDate = new Date(params.asOf)
  if (asOfDate.getTime() > Date.now()) {
    throw new InvalidAsOfError('asOf cannot be in the future')
  }
  if (asOfDate.getTime() < org.createdAt.getTime()) {
    throw new InvalidAsOfError('asOf predates this organization')
  }

  const { orgState, projectState } = await replayAccessAsOf(tx, params.orgId, asOfDate)
  const reportUsers = await buildUsersFromState(tx, orgState, projectState)
  return { users: reportUsers, asOf: asOfDate.toISOString() }
}

export function paginateAccessReportUsers(
  reportUsers: AccessReportUser[],
  page: number,
  limit: number
): { pageUsers: AccessReportUser[]; total: number; hasNext: boolean } {
  const total = reportUsers.length
  const start = (page - 1) * limit
  const pageUsers = reportUsers.slice(start, start + limit)
  return { pageUsers, total, hasNext: page * limit < total }
}

const ACCESS_REPORT_CSV_HEADER =
  'user_id,display_name,org_role,status,project_id,project_role,granted_at'

/** AC-3 — one row per (user × project) pair, plus one row (empty project fields) for a user with
 * zero project memberships. Reuses 8.2's `toCsvRow()` RFC 4180 quoting mechanics (Architecture
 * Conflict Resolution table) — this report defines its own column set, not AC-E8c's literal
 * audit-event-export columns, since a membership snapshot has no event_type/ip_address/timestamp-
 * of-event concept. */
export function buildAccessReportCsv(reportUsers: AccessReportUser[]): string {
  const lines = [ACCESS_REPORT_CSV_HEADER]
  for (const user of reportUsers) {
    if (user.projects.length === 0) {
      lines.push(toCsvRow([user.userId, user.displayName, user.orgRole, user.status, '', '', '']))
      continue
    }
    for (const project of user.projects) {
      lines.push(
        toCsvRow([
          user.userId,
          user.displayName,
          user.orgRole,
          user.status,
          project.projectId,
          project.role,
          project.grantedAt,
        ])
      )
    }
  }
  return `${lines.join('\n')}\n`
}
