// Story 68.1 (Q2): complete, typed sample domain objects for unit tests. Each builder returns a
// valid instance of the real API type with neutral defaults; a test overrides only the fields it
// cares about, so fixtures stay type-checked against the API contract instead of being partial
// object literals.
import type {
  CredentialDependency,
  CredentialDetail,
  CredentialSummary,
  CredentialVersionSummary,
  ProjectDashboard,
  ProjectOverview,
  ProjectSummary,
  RotationSummary,
} from '@project-vault/shared'
import type { CredentialDependencyWithChecklistStatus } from '$lib/api/credentials.js'
import type {
  CredentialShareSummary,
  RotationRecommendedBucket,
} from '$lib/api/credential-shares.js'
import type { OrgUser } from '$lib/api/org-users.js'

const CREATED_AT = '2026-07-01T00:00:00.000Z'
export const SAMPLE_PROJECT_ID = 'project-1'
export const SAMPLE_CREDENTIAL_ID = 'credential-1'

export function sampleCredential(overrides: Partial<CredentialDetail> = {}): CredentialDetail {
  return {
    id: SAMPLE_CREDENTIAL_ID,
    projectId: SAMPLE_PROJECT_ID,
    orgId: 'org-1',
    name: 'Sample secret',
    description: null,
    tags: [],
    expiresAt: null,
    rotationSchedule: null,
    cacheable: true,
    retentionCount: 10,
    currentVersionNumber: 1,
    schemaVersion: 2,
    fields: [{ key: 'value', sensitive: true }],
    visibleFieldValues: {},
    createdBy: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    archivedAt: null,
    ...overrides,
  }
}

export function sampleProject(overrides: Partial<ProjectOverview> = {}): ProjectOverview {
  return {
    id: SAMPLE_PROJECT_ID,
    orgId: 'org-1',
    name: 'Sample project',
    slug: 'sample-project',
    description: null,
    role: 'member',
    tags: [],
    memberCount: 1,
    createdBy: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    archivedAt: null,
    ...overrides,
  }
}

export function sampleDependency(
  overrides: Partial<CredentialDependencyWithChecklistStatus> = {}
): CredentialDependencyWithChecklistStatus {
  const dependency: CredentialDependency = {
    id: 'dep-1',
    credentialId: SAMPLE_CREDENTIAL_ID,
    systemName: 'billing-worker',
    systemType: 'service',
    notes: null,
    linkUrl: null,
    createdBy: null,
    archivedAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    fieldKey: null,
  }
  return { ...dependency, checklistStatus: null, ...overrides }
}

export function sampleShare(
  overrides: Partial<CredentialShareSummary> = {}
): CredentialShareSummary {
  return {
    id: 'share-1',
    credentialId: SAMPLE_CREDENTIAL_ID,
    fieldKey: null,
    attributeKeys: null,
    action: 'read',
    sharedBy: 'sharer-1',
    recipientType: 'user',
    recipientUserId: 'recipient-1',
    recipientEmail: null,
    singleUse: true,
    createdAt: '2026-07-28T00:00:00.000Z',
    expiresAt: '2026-07-29T00:00:00.000Z',
    revokedAt: null,
    firstViewedAt: null,
    viewCount: 0,
    status: 'active',
    ...overrides,
  }
}

export function sampleVersion(
  overrides: Partial<CredentialVersionSummary> = {}
): CredentialVersionSummary {
  return {
    versionNumber: 1,
    createdBy: null,
    createdAt: CREATED_AT,
    isCurrent: true,
    purgedAt: null,
    abandonedAt: null,
    schemaVersion: 2,
    ...overrides,
  }
}

export function sampleRotation(overrides: Partial<RotationSummary> = {}): RotationSummary {
  return {
    id: 'rotation-1',
    status: 'in_progress',
    initiatedBy: null,
    initiatedAt: CREATED_AT,
    completedAt: null,
    itemCount: 0,
    confirmedCount: 0,
    ...overrides,
  }
}

export function sampleNudge(
  overrides: Partial<RotationRecommendedBucket> = {}
): RotationRecommendedBucket {
  return {
    fieldKey: null,
    active: true,
    mostRecentShareAt: null,
    mostRecentSharedWith: null,
    ...overrides,
  }
}

export function sampleOrgUser(overrides: Partial<OrgUser> = {}): OrgUser {
  return {
    userId: 'user-1',
    email: 'user@example.com',
    displayName: 'Sample User',
    orgRole: 'member',
    status: 'active',
    projects: [],
    ...overrides,
  }
}

export function sampleProjectSummary(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: SAMPLE_PROJECT_ID,
    name: 'Sample project',
    slug: 'sample-project',
    description: null,
    role: 'owner',
    credentialCount: 0,
    expiringCount: 0,
    alertCount: 0,
    tags: [],
    createdAt: CREATED_AT,
    archivedAt: null,
    isArchived: false,
    ...overrides,
  }
}

/** A non-empty project dashboard with every section present and nothing outstanding. */
export function sampleProjectDashboard(
  overrides: Partial<ProjectDashboard> = {}
): ProjectDashboard {
  return {
    credentialStats: { active: 0, expiringSoon: 0, expired: 0 },
    upcomingRotations: [],
    monitoredServiceHealth: { healthy: 0, degraded: 0, down: 0 },
    recentAccessEvents: [],
    unresolvedAlertCount: 0,
    isEmpty: false,
    suggestedActions: [],
    ...overrides,
  }
}

export function sampleCredentialSummary(
  overrides: Partial<CredentialSummary> = {}
): CredentialSummary {
  return {
    id: SAMPLE_CREDENTIAL_ID,
    projectId: SAMPLE_PROJECT_ID,
    name: 'Sample secret',
    description: null,
    tags: [],
    status: 'active',
    expiresAt: null,
    rotationSchedule: null,
    currentVersionNumber: 1,
    hasDependencies: false,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    activeRotation: null,
    archivedAt: null,
    ...overrides,
  }
}
