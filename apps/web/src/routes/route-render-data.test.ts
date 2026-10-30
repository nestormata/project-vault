// @pv-not-guard oracle of PV's own un-composed markup, valid only on PV's tree
import { cleanup, render } from '@testing-library/svelte'
import { createRawSnippet } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { serializeWithoutNoise } from '$lib/test/dom.js'

// The data-rich cases added in 69.10 render dates in the runner's local time zone. The snapshot was
// recorded in America/Panama (UTC-5, no DST), so pin it for any runner (CI runs in UTC).
process.env.TZ = 'America/Panama'

// Story 69.5 AC-5: the DATA-RICH twin of route-render-snapshot.test.ts. That oracle renders every
// route file against an EMPTY permissive `data`, so almost no `{#if data.x}` / `{#each}` branch is
// exercised, and two routes throw. This one renders the same 73 route files against a FULL
// permissive `data` (every property is truthy, every list iterates two stable items, every string is
// the unique path of the value that produced it, e.g. `r.users.0.email`) in four variants:
//   full    - every branch that needs data renders, role and gate flags are other truthy values
//   owner   - as full, with the role/gate fields set to an owner who may manage everything
//   denied  - as full, with the role/gate fields set to a viewer who may manage nothing
//   form    - as owner, with a truthy `form` action result (error banners, success notices)
// plus the one route whose own state is browser-only (`projects/preview`) with and without its
// preview project. The snapshot was recorded from `main` @ effe4f8d BEFORE any component was
// extracted and is committed first. After the componentization the same text must come out: never
// regenerate it. The only legitimate change is a deliberate, signed-off markup change in a later
// story. Normalization is `serializeWithoutNoise` (comment nodes and script bodies) plus a
// whitespace collapse; no regex over HTML.

const previewState = vi.hoisted(() => ({ project: null as unknown }))
// DW-606: the project card tag editor reads the caller's org role from the layout data
// (`page.data.user.orgRole`); only the projects list page sets it, every other route sees `{}`.
const pageState = vi.hoisted(() => ({ data: {} as Record<string, unknown> }))

vi.mock('$lib/state/preview-project.svelte.js', () => ({
  getPreviewProject: () => previewState.project,
}))
vi.mock('$app/state', () => ({
  page: {
    status: 404,
    error: { message: 'Not Found' },
    get data() {
      return pageState.data
    },
    params: {},
    url: new URL('http://localhost/'),
    route: { id: null },
    form: null,
    state: {},
  },
  navigating: { to: null },
  updated: { current: false },
}))
vi.mock('$app/navigation', () => ({
  beforeNavigate: vi.fn(),
  goto: vi.fn(),
  invalidate: vi.fn(),
  invalidateAll: vi.fn(),
  afterNavigate: vi.fn(),
  onNavigate: vi.fn(),
  pushState: vi.fn(),
  replaceState: vi.fn(),
  preloadData: vi.fn(),
  preloadCode: vi.fn(),
}))
vi.mock('$app/forms', () => ({
  enhance: () => ({ destroy: () => undefined }),
  applyAction: vi.fn(),
  deserialize: vi.fn(),
}))

const routes = import.meta.glob('./**/+{page,layout,error}.svelte', { eager: true }) as Record<
  string,
  { default: never }
>

type Overrides = Record<string, unknown>

/** A full stand-in for any `data` shape. Properties are memoized, so `{#each}` keys stay stable
 * across reads, and each value carries its own path as its string form. */
function full(path: string, overrides: Overrides = {}): unknown {
  const memo = new Map<string | symbol, unknown>()
  const pinned = new Map(Object.entries(overrides))
  let items: unknown[] | null = null
  const target = function () {
    return full(`${path}()`)
  }
  return new Proxy(target, {
    get(_target, key) {
      if (key === Symbol.iterator) {
        return function* () {
          items ??= [full(`${path}.0`), full(`${path}.1`)]
          yield* items
        }
      }
      if (key === Symbol.toPrimitive) return (hint: string) => (hint === 'number' ? 1 : path)
      if (key === 'length') return 2
      if (key === 'then') return undefined
      if (key === 'toJSON') return () => path
      if (typeof key === 'string' && pinned.has(key)) {
        return override(`${path}.${key}`, pinned.get(key))
      }
      if (!memo.has(key)) memo.set(key, full(`${path}.${String(key)}`))
      return memo.get(key)
    },
    has: () => true,
  })
}

function isPlainObject(value: unknown): value is Overrides {
  return (
    typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
  )
}

/** A plain-object override is itself a full value with those properties pinned; everything else
 * (scalars, arrays, null, a ready-made object with a prototype) is returned as given. */
function override(path: string, value: unknown): unknown {
  return isPlainObject(value) ? full(path, value) : value
}

const GATES_OPEN: Overrides = {
  orgRole: 'owner',
  role: 'owner',
  canManage: true,
  canEdit: true,
  isAdmin: true,
  allowed: true,
}
const GATES_SHUT: Overrides = {
  orgRole: 'viewer',
  role: 'viewer',
  canManage: false,
  canEdit: false,
  isAdmin: false,
  allowed: false,
}
const NEGATIVES_OFF: Overrides = {
  errorMessage: null,
  eventsErrorMessage: null,
  maintenanceStatusError: null,
  error: null,
  notFound: false,
  vaultSealed: false,
  mfaRequired: false,
  statusTokenLoadFailed: false,
}
const VARIANTS = {
  full: { data: {}, form: null },
  errors: { data: GATES_OPEN, form: null },
  ready: { data: { ...GATES_OPEN, ...NEGATIVES_OFF }, form: null },
  denied: { data: { ...GATES_SHUT, ...NEGATIVES_OFF }, form: null },
  form: { data: { ...GATES_OPEN, ...NEGATIVES_OFF }, form: 'form' },
} as const

const OWNER_READY: Overrides = { ...GATES_OPEN, ...NEGATIVES_OFF }
const ACTIVE_SHARE = { status: 'active', singleUse: true }

/** Routes whose body switches on a string discriminator or a list length that a truthy value
 * never selects: one extra render per branch, keyed by the route file's path suffix. */
const BRANCHES: Record<string, Record<string, Overrides>> = {
  '/(app)/settings/users/[userId]/erasure/[requestId]/+page.svelte': Object.fromEntries(
    ['not_allowed', 'not_found', 'in_progress', 'pending', 'completed'].map((state) => [
      `state-${state}`,
      { ...OWNER_READY, state },
    ])
  ),
  '/(app)/shares/[token]/+page.svelte': {
    'error-not_found': { ...OWNER_READY, error: 'not_found' },
    'error-session_mismatch': { ...OWNER_READY, error: 'session_mismatch' },
    'metadata-active': { ...OWNER_READY, error: null, metadata: ACTIVE_SHARE },
  },
  '/external-shares/[token]/+page.svelte': {
    'error-not_found': { ...OWNER_READY, error: 'not_found' },
    'error-unavailable': { ...OWNER_READY, error: 'unavailable' },
    'metadata-active': { ...OWNER_READY, error: null, metadata: ACTIVE_SHARE },
  },
  '/status/[token]/+page.svelte': {
    'no-services': { ...OWNER_READY, statusPage: { services: [] } },
    'no-page': { ...OWNER_READY, statusPage: null },
  },
}

// Handcrafted, realistic data for the route whose body the permissive value cannot reach (the
// resource-usage page computes percentages and thresholds from numbers).
const RECONCILED_AT = '2026-10-04T11:00:00.000Z'
const ORG_ROW = {
  orgId: 'org-ok',
  orgName: 'Ok Org',
  bytesUsed: 100_000_000,
  preauthBytesUsed: 0,
  quotaBytes: 1_073_741_824,
  utilizationPct: 9.31,
  refusedWriteCount: 0,
  lastRefusalAt: null,
  lastReconciledAt: RECONCILED_AT,
  writeRatePerMinute: null,
  rateWindowCount: 0,
  rateRefusedCount: 0,
  state: 'ok',
}
const AUDIT_ROWS = [
  ORG_ROW,
  {
    ...ORG_ROW,
    orgId: 'org-unlimited',
    orgName: 'Unlimited Org',
    quotaBytes: null,
    utilizationPct: null,
    state: 'unlimited',
  },
  { ...ORG_ROW, orgId: 'org-stale', orgName: 'Stale Org', lastReconciledAt: null, state: 'stale' },
  {
    ...ORG_ROW,
    orgId: 'org-warn',
    orgName: 'Warn Org',
    utilizationPct: 91,
    state: 'warning',
    writeRatePerMinute: 4,
    rateWindowCount: 9,
    rateRefusedCount: 1,
  },
  { ...ORG_ROW, orgId: 'org-crit', orgName: 'Crit Org', utilizationPct: 97, state: 'critical' },
  {
    ...ORG_ROW,
    orgId: 'org-blocked',
    orgName: 'Blocked Org',
    bytesUsed: 2_000_000_000,
    utilizationPct: 186.3,
    state: 'blocked',
    refusedWriteCount: 3,
    lastRefusalAt: RECONCILED_AT,
  },
]
const BACKUPS = [
  {
    filename: 'vault-2026-10-01.pvbak',
    timestamp: '2026-10-01T03:00:00.000Z',
    sizeBytes: 2_048_000,
    keyVersion: 3,
    verified: 'valid',
    status: 'succeeded',
    errorMessage: null,
  },
  {
    filename: 'vault-2026-10-02.pvbak',
    timestamp: '2026-10-02T03:00:00.000Z',
    sizeBytes: null,
    keyVersion: null,
    verified: 'invalid',
    status: 'failed',
    errorMessage: 'disk full',
  },
  {
    filename: 'vault-2026-10-03.pvbak',
    timestamp: '2026-10-03T03:00:00.000Z',
    sizeBytes: null,
    keyVersion: 3,
    verified: 'unverified',
    status: 'running',
    errorMessage: null,
  },
  {
    filename: 'vault-2026-10-04.pvbak',
    timestamp: '2026-10-04T03:00:00.000Z',
    sizeBytes: 1_024,
    keyVersion: 4,
    verified: 'unverified',
    status: 'failed',
    errorMessage: null,
  },
]
function usage(overrides: Overrides): Overrides {
  return {
    orgs: { current: 3, limit: 10 },
    usersPerOrg: [{ orgId: 'org-1', current: 5, limit: 50 }],
    secretsPerProject: [{ projectId: 'project-1', orgId: 'org-1', current: 7 }],
    auditLogEntries: { current: 1000, limit: null },
    storageBytes: { current: 900_000, limit: null },
    auditLogStorage: {
      currentBytes: 42_000_000_000,
      limitBytes: 50_000_000_000,
      utilizationPct: 84,
    },
    auditStorageByOrg: AUDIT_ROWS,
    truncated: false,
    allocatedLogicalBytes: 5_000_000_000,
    estimatedPhysicalBytes: 2_000_000_000,
    allocationIncludesUnlimitedOrgs: true,
    observedPhysicalToLogicalRatio: 0.42,
    ...overrides,
  }
}
// Story 69.10: realistic users for the users page, whose rows branch on `status`, project roles and
// the org role (a permissive value matches none of them). Recorded BEFORE the page's sections were
// split into sub-region components.
const USERS = [
  {
    userId: 'u-active',
    email: 'active.member',
    displayName: 'Active Member',
    orgRole: 'member',
    status: 'active',
    projects: [
      { projectId: 'p-alpha', projectName: 'Alpha', role: 'owner' },
      { projectId: 'p-beta', projectName: 'Beta', role: 'viewer' },
    ],
  },
  {
    userId: 'u-gone',
    email: 'gone.user',
    displayName: 'Gone User',
    orgRole: 'viewer',
    status: 'deactivated',
    projects: [],
  },
]
// Story 69.10: platform audit page states a permissive value cannot select (events, empty and
// filtered lists, inactive and unavailable maintenance status), recorded BEFORE the split.
const PLATFORM_AUDIT_EVENTS = [
  {
    id: 'ev-1',
    actionType: 'org.suspend',
    operatorId: 'op-1',
    targetOrgId: 'org-9',
    targetUserId: null,
    ipAddress: '10.0.0.1',
    timestamp: '2026-10-01T10:00:00.000Z',
  },
  {
    id: 'ev-2',
    actionType: 'maintenance.activate',
    operatorId: 'op-2',
    targetOrgId: null,
    targetUserId: 'user-3',
    ipAddress: null,
    timestamp: '2026-10-02T11:30:00.000Z',
  },
]
const PLATFORM_AUDIT_BASE: Overrides = {
  ...OWNER_READY,
  filters: {},
  events: PLATFORM_AUDIT_EVENTS,
  total: 2,
  page: 1,
  hasNext: false,
  maintenanceStatus: { active: false },
}
// Story 69.10: platform settings states a permissive value cannot select (an unset SMTP password and
// no backup storage, an unconfigured token, a failed token load), recorded BEFORE the split.
const PLATFORM_SETTINGS = {
  smtp: {
    host: 'smtp.example.test',
    port: 587,
    user: 'mailer',
    from: 'noreply.example',
    configured: false,
  },
  backup: { schedule: '0 2 * * *', retentionCount: 7, storageType: null },
  notifications: { defaultSlackWebhook: null },
  instancePolicy: { maxOrgs: 10, maxUsersPerOrg: 50, sessionIdleTimeoutMinutes: 30 },
}
// Story 69.10: credentials list states a permissive value cannot select (status classes, archived and
// rotation badges, tags, and the empty state wording per filter and role), recorded BEFORE the split.
const CREDENTIAL_ITEMS = [
  {
    id: 'c-1',
    name: 'Stripe key',
    status: 'active',
    tags: ['payments', 'prod'],
    expiresAt: '2026-12-01T00:00:00.000Z',
    hasDependencies: true,
    archivedAt: null,
    activeRotation: { status: 'staged', rotationId: 'rot-1' },
  },
  {
    id: 'c-2',
    name: 'Old token',
    status: 'expired',
    tags: [],
    expiresAt: null,
    hasDependencies: false,
    archivedAt: '2026-09-01T00:00:00.000Z',
    activeRotation: null,
  },
  {
    id: 'c-3',
    name: 'Soon token',
    status: 'expiring',
    tags: ['db'],
    expiresAt: '2026-11-01T00:00:00.000Z',
    hasDependencies: false,
    archivedAt: null,
    activeRotation: null,
  },
]
// Story 69.11: realistic projects for the projects list, whose cards branch on role, archived state,
// tags and description (a permissive value matches none of the string checks). Recorded BEFORE the
// list was split into sub-region components.
const PROJECT_ITEMS = [
  {
    id: 'p-owner',
    name: 'Owner Project',
    slug: 'owner-project',
    description: 'An active project the caller owns',
    role: 'owner',
    isArchived: false,
    tags: ['production', 'api'],
    credentialCount: 4,
    expiringCount: 1,
    alertCount: 2,
  },
  {
    id: 'p-viewer',
    name: 'Viewer Project',
    slug: 'viewer-project',
    description: null,
    role: 'viewer',
    isArchived: false,
    tags: [],
    credentialCount: 0,
    expiringCount: 0,
    alertCount: 0,
  },
  {
    id: 'p-member',
    name: 'Member Project',
    slug: 'member-project',
    description: null,
    role: 'member',
    isArchived: false,
    tags: ['shared'],
    credentialCount: 2,
    expiringCount: 0,
    alertCount: 0,
  },
  {
    id: 'p-archived-owner',
    name: 'Archived Owner Project',
    slug: 'archived-owner-project',
    description: 'Hidden from active views',
    role: 'owner',
    isArchived: true,
    tags: ['old'],
    credentialCount: 9,
    expiringCount: 0,
    alertCount: 0,
  },
  {
    id: 'p-archived-viewer',
    name: 'Archived Viewer Project',
    slug: 'archived-viewer-project',
    description: null,
    role: 'viewer',
    isArchived: true,
    tags: [],
    credentialCount: 1,
    expiringCount: 0,
    alertCount: 0,
  },
]
// Story 69.11: realistic erasure request data. The route's branches switch on `state`, `orgRole`,
// `userEmail` and `piiInventory`, which a permissive value never separates. Recorded BEFORE the
// panel was split into sub-region components.
const ERASURE_BASE = {
  ...OWNER_READY,
  userId: 'u-erase',
  requestId: 'req-1',
  userEmail: 'jane.doe@example',
}
const ERASURE_INVENTORY = {
  tables: [
    { table: 'org_users', rowCount: 1, piiFields: ['email', 'displayName'] },
    { table: 'audit_events', rowCount: 12, piiFields: ['actorEmail'] },
  ],
}
const ERASURE_REPORT = {
  executedAt: '2026-10-05T12:30:00.000Z',
  piiRemoved: [{ table: 'org_users', fields: ['email', 'displayName'], method: 'hard_delete' }],
  piiRetained: [{ table: 'audit_events', reason: 'legal retention' }],
  retentionJustification: 'Audit rows are kept for compliance',
  auditEventId: 'evt-1',
}
// Story 69.11: realistic inbox entries for the notifications page, whose cards branch on severity,
// alert type, read state and project link, and whose footer branches on the page number. Recorded
// BEFORE the list was split into sub-region components.
const INBOX_ENTRIES = [
  {
    id: 'n-unread',
    alertType: 'credential.expiry',
    severity: 'critical',
    title: 'Secret expires soon',
    body: 'The secret expires in 3 days.',
    projectId: 'p-1',
    createdAt: '2026-10-04T10:00:00.000Z',
    readAt: null,
  },
  {
    id: 'n-read',
    alertType: 'service.down',
    severity: 'warning',
    title: 'Service is down',
    body: 'The health check failed.',
    projectId: null,
    createdAt: '2026-10-03T10:00:00.000Z',
    readAt: '2026-10-03T12:00:00.000Z',
  },
  {
    id: 'n-custom',
    alertType: 'custom.alert',
    severity: 'unknown',
    title: 'Custom alert',
    body: 'An alert type without a label.',
    projectId: 'p-2',
    createdAt: '2026-10-02T10:00:00.000Z',
    readAt: null,
  },
]
const NOTIFICATIONS_PAGE = {
  ...OWNER_READY,
  notifications: INBOX_ENTRIES,
  status: 'all',
  page: 1,
  hasNext: false,
  dormancyAlerts: [],
  userDormancyAlerts: [],
}
// Story 69.11: realistic extension status data. The page switches on `allowed`, `mfaRequired`,
// `errorMessage`, `manifest` and `healthStatus`, which a permissive value never separates.
// Recorded BEFORE the status panel was split into sub-region components.
const EXTENSION_MANIFEST = {
  name: 'test.mock-extension',
  apiVersion: '3.30.0',
  packageVersion: '1.2.3',
  capabilities: ['capability-gate', 'audit-event-source', 'capability-gate'],
  loadedAt: '2026-10-04T08:00:00.000Z',
}
const EXTENSIONS_ALLOWED = {
  allowed: true,
  mfaRequired: false,
  errorMessage: null,
  manifest: null,
  healthStatus: 'not_configured',
}

// Story 69.11: realistic external identities and members. The panel's list renders dates and an
// empty state a permissive value never reaches. Recorded BEFORE the panel was split into
// sub-region components.
const EXTERNAL_IDENTITIES = [
  {
    id: 'ei-1',
    email: 'alex@example',
    providerName: 'test.mock-sso-extension',
    externalSubject: 'alex-sso-subject-123',
    createdAt: '2026-10-01T10:00:00.000Z',
  },
  {
    id: 'ei-2',
    email: 'sam@example',
    providerName: 'corp.idp',
    externalSubject: 'sam-subject',
    createdAt: '2026-10-02T11:30:00.000Z',
  },
]
const EXTERNAL_IDENTITY_USERS = [
  { userId: 'u-alex', email: 'alex@example' },
  { userId: 'u-sam', email: 'sam@example' },
]
// Story 69.11: a realistic access report. The page branches on the report's users (status,
// projects), its page number and `hasNext`, the `asOf` date and the load error, none of which a
// permissive value separates. Recorded BEFORE the panel was split into sub-region components.
const ACCESS_REPORT_USERS = [
  {
    userId: 'u-active',
    displayName: 'Active Member',
    orgRole: 'member',
    status: 'active',
    projects: [
      { projectId: 'p-alpha', projectName: 'Alpha', role: 'owner' },
      { projectId: 'p-beta', projectName: 'Beta', role: 'viewer' },
    ],
  },
  {
    userId: 'u-off',
    displayName: 'Former Member',
    orgRole: 'viewer',
    status: 'deactivated',
    projects: [],
  },
]
const ACCESS_REPORT = {
  asOf: '2026-10-01T00:00:00.000Z',
  generatedAt: '2026-10-05T09:30:00.000Z',
  hasNext: false,
  users: ACCESS_REPORT_USERS,
}
const ACCESS_REPORT_PAGE = {
  ...OWNER_READY,
  asOf: undefined,
  page: 1,
  report: ACCESS_REPORT,
}

// Story 69.11: realistic organizations for the platform organizations page, whose list renders
// dates and an empty state a permissive value never reaches. Recorded BEFORE the page content was
// split into sub-region components.
const PLATFORM_ORGS = [
  {
    id: 'org-1',
    name: 'Acme Corp',
    slug: 'acme-corp',
    createdAt: '2026-09-01T10:00:00.000Z',
    memberCount: 12,
  },
  {
    id: 'org-2',
    name: 'Beta LLC',
    slug: 'beta-llc',
    createdAt: '2026-09-15T10:00:00.000Z',
    memberCount: 3,
  },
]
// Story 69.11: realistic status page admin data. The "Services shown" card branches on the number
// of selected services, the endpoints list and the capability gate, which a permissive value never
// separates. Recorded BEFORE the card was split into sub-region components.
const STATUS_PAGE_ENDPOINTS = [
  { id: 'se-1', name: 'API gateway' },
  { id: 'se-2', name: 'Web app' },
  { id: 'se-3', name: 'Billing' },
]
const STATUS_PAGE_BASE = {
  ...OWNER_READY,
  canManage: true,
  projectId: 'p-1',
  origin: 'https://vault.example.com',
  capabilities: { 'monitoring.public-status-page': true },
  serviceEndpoints: STATUS_PAGE_ENDPOINTS,
  config: {
    enabled: true,
    token: 'tok-123',
    legacyToken: false,
    services: [
      { serviceId: 'se-1', displayName: 'Gateway' },
      { serviceId: 'se-2', displayName: 'Website' },
    ],
  },
}
// Story 69.11: realistic project members. The team card branches on the member role (owner badge vs
// role select), an empty list and the transfer-ownership gate, none of which a permissive value
// separates. Recorded BEFORE the team panel was split into sub-region components.
const PROJECT_MEMBERS = [
  { userId: 'u-owner', displayName: 'Olive Owner', email: 'olive@example', role: 'owner' },
  { userId: 'u-admin', displayName: 'Adam Admin', email: 'adam@example', role: 'admin' },
  { userId: 'u-view', displayName: 'Vera Viewer', email: 'vera@example', role: 'viewer' },
]
const MEMBERS_PAGE = {
  ...OWNER_READY,
  projectId: 'p-1',
  userId: 'u-owner',
  canManage: true,
  canManageMembers: true,
  canTransferOwnership: true,
  members: PROJECT_MEMBERS,
  invitations: [],
}

const ROTATION_DETAIL_ROUTE =
  '/(app)/projects/[projectId]/credentials/[credentialId]/rotations/[rotationId]/+page.svelte'
const ROTATE_ROUTE = '/(app)/projects/[projectId]/credentials/[credentialId]/rotate/+page.svelte'
const ROTATION_ITEM = {
  dependencyId: null,
  confirmedBy: null,
  confirmedAt: null,
  retryCount: 0,
  retryScheduledAt: null,
  lastFailureReason: null,
  lastActedBy: null,
  lastActedAt: null,
  notes: null,
}
const ROTATION_ITEMS_MIXED = [
  { ...ROTATION_ITEM, id: 'ri-1', systemName: 'billing-worker', status: 'unconfirmed' },
  {
    ...ROTATION_ITEM,
    id: 'ri-2',
    systemName: 'api-gateway',
    status: 'confirmed',
    confirmedAt: '2026-10-03T10:00:00.000Z',
    lastActedAt: '2026-10-03T10:00:00.000Z',
  },
  {
    ...ROTATION_ITEM,
    id: 'ri-3',
    systemName: 'cron-runner',
    status: 'failed',
    retryCount: 1,
    lastFailureReason: 'timeout',
  },
]
const ROTATION_ITEMS_CONFIRMED = ROTATION_ITEMS_MIXED.map((item) => ({
  ...item,
  status: 'confirmed',
}))
function rotationDetail(status: string, checklistItems: readonly unknown[], extra: Overrides = {}) {
  return {
    id: 'rot-1',
    credentialId: 'cred-1',
    projectId: 'proj-1',
    status,
    version: 2,
    initiatedBy: null,
    initiatedAt: '2026-10-03T09:00:00.000Z',
    completedAt: null,
    notes: null,
    targetFields: null,
    checklistItems,
    ...extra,
  }
}
function rotationCases(
  label: string,
  status: string,
  checklistItems: readonly unknown[],
  extra: Overrides = {}
): Record<string, Overrides> {
  return Object.fromEntries(
    (['owner', 'member', 'viewer'] as const).map((orgRole) => [
      `rotation-${label}-${orgRole}`,
      { ...OWNER_READY, orgRole, rotation: rotationDetail(status, checklistItems, extra) },
    ])
  )
}
const ROTATION_DETAIL_CASES: Record<string, Overrides> = {
  ...rotationCases('in-progress-empty', 'in_progress', []),
  ...rotationCases('in-progress-mixed', 'in_progress', ROTATION_ITEMS_MIXED, {
    notes: 'quarterly rotation',
  }),
  ...rotationCases('in-progress-confirmed', 'in_progress', ROTATION_ITEMS_CONFIRMED),
  ...rotationCases('staged-empty', 'staged', []),
  ...rotationCases('staged-mixed', 'staged', ROTATION_ITEMS_MIXED),
  ...rotationCases('staged-confirmed', 'staged', ROTATION_ITEMS_CONFIRMED),
  ...rotationCases('promoted-empty', 'promoted', []),
  ...rotationCases('promoted-mixed', 'promoted', ROTATION_ITEMS_MIXED),
  ...rotationCases('promoted-confirmed', 'promoted', ROTATION_ITEMS_CONFIRMED),
  ...rotationCases('stale-recovery', 'stale_recovery', ROTATION_ITEMS_MIXED),
  ...rotationCases('retired', 'retired', ROTATION_ITEMS_CONFIRMED),
  ...rotationCases('abandoned', 'abandoned', ROTATION_ITEMS_MIXED),
  ...rotationCases('completed', 'completed', ROTATION_ITEMS_CONFIRMED, {
    completedAt: '2026-10-03T12:00:00.000Z',
  }),
  'rotation-not-found': { ...OWNER_READY, rotation: null, notFound: true },
  'rotation-sealed': { ...OWNER_READY, rotation: null, vaultSealed: true },
}
const ROTATE_DEPENDENCIES = {
  hasDependencies: true,
  items: [
    { id: 'dep-1', systemName: 'billing-worker' },
    { id: 'dep-2', systemName: 'api-gateway' },
  ],
}
const ROTATE_FIELDS = [
  { key: 'username', type: 'text' },
  { key: 'password', type: 'secret' },
]
const ROTATE_READY: Overrides = {
  ...OWNER_READY,
  canManage: true,
  dependencies: ROTATE_DEPENDENCIES,
  fieldMeta: [{ key: 'value', type: 'secret' }],
  activeRotationId: null,
}
const ROTATE_CASES: Record<string, Overrides> = {
  'rotate-single-field': ROTATE_READY,
  'rotate-multi-field': { ...ROTATE_READY, fieldMeta: ROTATE_FIELDS },
  'rotate-no-dependencies': {
    ...ROTATE_READY,
    dependencies: { hasDependencies: false, items: [] },
  },
  'rotate-active-rotation': { ...ROTATE_READY, activeRotationId: 'rot-active' },
  'rotate-active-multi-field': {
    ...ROTATE_READY,
    fieldMeta: ROTATE_FIELDS,
    activeRotationId: 'rot-active',
  },
  'rotate-viewer': {
    ...OWNER_READY,
    orgRole: 'viewer',
    canManage: false,
    dependencies: null,
    fieldMeta: null,
    activeRotationId: null,
  },
  'rotate-member': {
    ...OWNER_READY,
    orgRole: 'member',
    canManage: false,
    dependencies: null,
    fieldMeta: null,
    activeRotationId: null,
  },
  'rotate-sealed': { ...OWNER_READY, vaultSealed: true, dependencies: null, fieldMeta: null },
}
// Story 69-14: credential detail states a permissive value cannot select (the secret value section
// branches on single vs multi-field secrets, the caller's role on the project, the archived flag and
// the visible field values; the dependencies section on its list, the staged rotation and each
// checklist status), recorded BEFORE the two sections were split into sub-region components.
const DETAIL_PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DETAIL_CREDENTIAL_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const DETAIL_BASE_CREDENTIAL = {
  id: DETAIL_CREDENTIAL_ID,
  projectId: DETAIL_PROJECT_ID,
  orgId: 'org-1',
  name: 'Stripe key',
  description: 'Payments secret',
  tags: ['payments'],
  expiresAt: '2026-12-01T00:00:00.000Z',
  rotationSchedule: null,
  cacheable: true,
  retentionCount: 10,
  currentVersionNumber: 2,
  schemaVersion: 2,
  createdBy: null,
  createdAt: '2026-07-01T12:00:00.000Z',
  updatedAt: '2026-07-01T12:00:00.000Z',
  archivedAt: null,
  fields: [{ key: 'value', sensitive: true }],
  visibleFieldValues: {},
}
const DETAIL_MULTI_CREDENTIAL = {
  ...DETAIL_BASE_CREDENTIAL,
  name: 'Database login',
  fields: [
    { key: 'host', sensitive: false },
    { key: 'password', sensitive: true },
    { key: 'token', sensitive: true },
  ],
  visibleFieldValues: { host: 'db.internal.example' },
}
const DETAIL_ARCHIVED = { archivedAt: '2026-09-01T00:00:00.000Z' }
const detailChecklist = (status: string, itemId: string) => ({
  rotationId: 'rot-9',
  itemId,
  status,
  confirmedBy: status === 'confirmed' ? 'user-1' : null,
  confirmedAt: status === 'confirmed' ? '2026-07-01T12:00:00.000Z' : null,
})
const detailDependency = (id: string, overrides: Overrides = {}): Overrides => ({
  id,
  credentialId: DETAIL_CREDENTIAL_ID,
  systemName: `system-${id}`,
  systemType: 'service',
  notes: null,
  linkUrl: null,
  createdBy: null,
  archivedAt: null,
  createdAt: '2026-07-01T12:00:00.000Z',
  updatedAt: '2026-07-01T12:00:00.000Z',
  fieldKey: null,
  checklistStatus: null,
  ...overrides,
})
const DETAIL_DEPENDENCIES = {
  items: [
    detailDependency('plain'),
    detailDependency('scoped', {
      systemType: 'ci_pipeline',
      fieldKey: 'password',
      linkUrl: 'https://ci.example.com/pipelines/1',
    }),
    detailDependency('pending', { checklistStatus: detailChecklist('pending', 'i1') }),
    detailDependency('confirmed', { checklistStatus: detailChecklist('confirmed', 'i2') }),
    detailDependency('failed', { checklistStatus: detailChecklist('failed', 'i3') }),
    detailDependency('maxed', {
      checklistStatus: detailChecklist('max_retries_exceeded', 'i4'),
    }),
  ],
  hasDependencies: true,
  hasStagedRotation: true,
}
const detailPage = (
  orgRole: string,
  projectRole: string,
  overrides: Overrides = {}
): Overrides => ({
  ...NEGATIVES_OFF,
  projectId: DETAIL_PROJECT_ID,
  credentialId: DETAIL_CREDENTIAL_ID,
  orgRole,
  project: { id: DETAIL_PROJECT_ID, name: 'Sample project', role: projectRole, archivedAt: null },
  origin: 'https://vault.example.com',
  credential: DETAIL_BASE_CREDENTIAL,
  dependencies: { items: [], hasDependencies: false, hasStagedRotation: false },
  versions: [],
  rotations: [],
  rotationsPage: 1,
  rotationsHasMore: false,
  activeRotationId: null,
  shares: [],
  sharesTotal: 0,
  sharesPage: 1,
  sharesStatus: null,
  rotationRecommendedNudges: [],
  orgMembers: [],
  ...overrides,
})
const NO_FILTERS = { q: '', status: '', tags: '', page: 1, includeArchived: false }
// Story 69.14: machine user detail states a permissive value cannot select (an active or a
// deactivated user, a manager or a viewer, revoked and active keys with and without dates, no
// description, no keys), recorded BEFORE the split.
const MACHINE_USER = {
  name: 'Deploy bot',
  description: 'Deploys to staging',
  role: 'member',
  createdAt: '2026-09-01T08:00:00.000Z',
  deactivatedAt: null,
  scopeBoundary: {
    canAccess: ['staging secrets', 'read credentials'],
    cannotAccess: ['production secrets'],
  },
}
const MACHINE_USER_KEYS = {
  items: [
    {
      id: 'k-1',
      name: 'CI key',
      expiresAt: '2026-12-01T00:00:00.000Z',
      lastUsedAt: '2026-10-02T10:00:00.000Z',
      isRevoked: false,
    },
    { id: 'k-2', name: 'Old key', expiresAt: null, lastUsedAt: null, isRevoked: true },
  ],
  total: 2,
}
const MACHINE_USER_BASE: Overrides = {
  ...OWNER_READY,
  projectId: 'p-1',
  machineUserId: 'mu-1',
  machineUser: MACHINE_USER,
  apiKeys: MACHINE_USER_KEYS,
}
// Story 69.12: the settings audit page. A plain-object filters value would turn into a permissive
// proxy that iterates as empty, so `hasFilters` could never be true: a null-prototype object is
// passed through as given.
const nullProto = (value: Overrides): Overrides => Object.assign(Object.create(null), value)
const AUDIT_ATTRIBUTION_EVENTS = [
  {
    id: 'evt-a',
    eventType: 'credential.access',
    actorDisplayName: 'Dana Smith',
    resourceId: 'cred-1',
    resourceType: 'credential',
    projectId: 'proj-1',
    ipAddress: '203.0.113.4',
    createdAt: '2026-10-01T10:00:00.000Z',
    attribution: {
      actor: {
        kind: 'issuer_attested',
        provider: 'cm',
        subject: 'user-1',
        reason: 'not_current_member',
      },
      occurredAt: '2026-10-01T09:00:00.000Z',
      occurredAtSource: 'delegation_signed',
    },
  },
  {
    id: 'evt-b',
    eventType: 'member.invited',
    actorDisplayName: 'Olivia Owner',
    resourceId: null,
    resourceType: null,
    projectId: null,
    ipAddress: null,
    createdAt: '2026-10-01T09:00:00.000Z',
    attribution: {
      actor: { kind: 'issuer_attested', provider: 'cm', subject: 'user-2', reason: 'unlinked' },
      occurredAt: '2026-10-01T08:00:00.000Z',
      occurredAtSource: 'extension',
    },
  },
  {
    id: 'evt-c',
    eventType: 'credential.rotated',
    actorDisplayName: 'Adam Admin',
    resourceId: 'cred-2',
    resourceType: 'credential',
    projectId: 'proj-2',
    ipAddress: '198.51.100.7',
    createdAt: '2026-10-01T08:00:00.000Z',
    attribution: {
      actor: { kind: 'pv_verified', provider: 'cm', subject: 'user-3', reason: null },
      occurredAt: '2026-10-01T08:00:00.500Z',
    },
  },
  {
    id: 'evt-d',
    eventType: 'project.import_failed',
    actorDisplayName: 'Eve Editor',
    resourceId: null,
    resourceType: 'project_import',
    projectId: null,
    ipAddress: null,
    createdAt: '2026-10-01T07:00:00.000Z',
    attribution: {},
  },
]
const AUDIT_PAGE_BASE: Overrides = {
  ...OWNER_READY,
  filters: nullProto({}),
  events: AUDIT_ATTRIBUTION_EVENTS,
  total: 4,
  limit: 20,
  page: 1,
  hasNext: false,
}
const HANDCRAFTED: Record<string, Record<string, Overrides>> = {
  '/(app)/projects/[projectId]/machine-users/[machineUserId]/+page.svelte': {
    'machine-active-manager': MACHINE_USER_BASE,
    'machine-active-viewer': { ...MACHINE_USER_BASE, orgRole: 'viewer' },
    'machine-deactivated-manager': {
      ...MACHINE_USER_BASE,
      machineUser: { ...MACHINE_USER, deactivatedAt: '2026-10-10T00:00:00.000Z' },
    },
    'machine-no-description-no-keys': {
      ...MACHINE_USER_BASE,
      orgRole: 'admin',
      machineUser: { ...MACHINE_USER, description: null },
      apiKeys: { items: [], total: 0 },
    },
    'machine-not-found': { ...MACHINE_USER_BASE, notFound: true, machineUser: null },
  },
  '/(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte': {
    'detail-legacy-member': detailPage('member', 'member'),
    'detail-legacy-viewer': detailPage('viewer', 'viewer'),
    'detail-legacy-member-project-viewer': detailPage('member', 'viewer'),
    'detail-legacy-archived-owner': detailPage('owner', 'owner', {
      credential: { ...DETAIL_BASE_CREDENTIAL, ...DETAIL_ARCHIVED },
    }),
    'detail-multi-owner': detailPage('owner', 'owner', { credential: DETAIL_MULTI_CREDENTIAL }),
    'detail-multi-viewer': detailPage('viewer', 'viewer', { credential: DETAIL_MULTI_CREDENTIAL }),
    'detail-multi-all-sensitive': detailPage('owner', 'owner', {
      credential: {
        ...DETAIL_MULTI_CREDENTIAL,
        fields: [
          { key: 'a', sensitive: true },
          { key: 'b', sensitive: true },
        ],
        visibleFieldValues: {},
      },
    }),
    'detail-multi-archived-owner': detailPage('owner', 'owner', {
      credential: { ...DETAIL_MULTI_CREDENTIAL, ...DETAIL_ARCHIVED },
      dependencies: DETAIL_DEPENDENCIES,
    }),
    'detail-dependencies-staged-member': detailPage('member', 'member', {
      dependencies: DETAIL_DEPENDENCIES,
    }),
    'detail-dependencies-unstaged-multi-owner': detailPage('owner', 'owner', {
      credential: DETAIL_MULTI_CREDENTIAL,
      dependencies: { ...DETAIL_DEPENDENCIES, hasStagedRotation: false },
    }),
    'detail-dependencies-viewer': detailPage('viewer', 'viewer', {
      dependencies: DETAIL_DEPENDENCIES,
    }),
  },
  [ROTATION_DETAIL_ROUTE]: ROTATION_DETAIL_CASES,
  [ROTATE_ROUTE]: ROTATE_CASES,
  '/(app)/projects/[projectId]/credentials/+page.svelte': {
    'list-items': {
      ...OWNER_READY,
      filters: { ...NO_FILTERS, includeArchived: true },
      credentials: { items: CREDENTIAL_ITEMS, total: 3 },
    },
    'list-empty-filtered': {
      ...OWNER_READY,
      filters: { ...NO_FILTERS, q: 'zzz' },
      credentials: { items: [], total: 0 },
    },
    'list-empty-owner': {
      ...OWNER_READY,
      filters: NO_FILTERS,
      credentials: { items: [], total: 0 },
    },
    'list-empty-viewer': {
      ...OWNER_READY,
      orgRole: 'viewer',
      filters: NO_FILTERS,
      credentials: { items: [], total: 0 },
    },
  },
  '/(app)/platform/settings/+page.svelte': {
    'settings-token-unconfigured': {
      ...OWNER_READY,
      settings: PLATFORM_SETTINGS,
      statusToken: { configured: false },
    },
    'settings-token-configured': {
      ...OWNER_READY,
      settings: { ...PLATFORM_SETTINGS, smtp: { ...PLATFORM_SETTINGS.smtp, configured: true } },
      statusToken: {
        configured: true,
        createdAt: '2026-10-01T10:00:00.000Z',
        lastUsedAt: '2026-10-02T10:00:00.000Z',
      },
    },
    'settings-token-load-failed': {
      ...OWNER_READY,
      settings: PLATFORM_SETTINGS,
      statusToken: null,
      statusTokenLoadFailed: true,
    },
    'settings-load-error': { ...OWNER_READY, settings: null, errorMessage: 'settings unavailable' },
  },
  '/(app)/platform/audit/+page.svelte': {
    'audit-events': PLATFORM_AUDIT_BASE,
    'audit-events-filtered-next': {
      ...PLATFORM_AUDIT_BASE,
      filters: { actionType: 'org.suspend', from: '2026-10-01T00:00:00.000Z' },
      hasNext: true,
    },
    'audit-empty': { ...PLATFORM_AUDIT_BASE, events: [], total: 0 },
    'audit-empty-filtered': {
      ...PLATFORM_AUDIT_BASE,
      events: [],
      total: 0,
      filters: { operatorId: 'op-1' },
    },
    'audit-maintenance-active': {
      ...PLATFORM_AUDIT_BASE,
      maintenanceStatus: {
        active: true,
        activatedAt: '2026-10-03T09:00:00.000Z',
        reason: 'storage outage',
        pendingEntriesCount: 4,
      },
    },
    'audit-status-unavailable': {
      ...PLATFORM_AUDIT_BASE,
      maintenanceStatus: null,
      maintenanceStatusError: 'status unavailable',
    },
    'audit-events-error': { ...PLATFORM_AUDIT_BASE, eventsErrorMessage: 'events unavailable' },
  },
  '/(app)/settings/audit/+page.svelte': {
    'audit-attribution-rows': AUDIT_PAGE_BASE,
    'audit-eight-filters-next': {
      ...AUDIT_PAGE_BASE,
      filters: nullProto({
        eventType: 'credential.access',
        actorId: 'actor-9',
        actorProvider: 'cm',
        actorSubject: 'user-1',
        resourceId: 'cred-1',
        projectId: 'proj-1',
        from: '2026-10-01',
        to: '2026-10-31',
      }),
      page: 2,
      total: 45,
      hasNext: true,
    },
    'audit-only-from': {
      ...AUDIT_PAGE_BASE,
      filters: nullProto({ from: '2026-10-01' }),
    },
    'audit-empty-filtered': {
      ...AUDIT_PAGE_BASE,
      events: [],
      total: 0,
      filters: nullProto({ eventType: 'nothing.here' }),
    },
    'audit-error': { ...AUDIT_PAGE_BASE, events: [], total: 0, errorMessage: 'load failed' },
  },
  '/(app)/settings/users/+page.svelte': {
    'users-owner': { ...OWNER_READY, orgRole: 'owner', users: USERS, nativeLoginEnabled: true },
    'users-admin-external-login': {
      ...OWNER_READY,
      orgRole: 'admin',
      users: USERS,
      nativeLoginEnabled: false,
    },
    'users-empty': { ...OWNER_READY, users: [] },
  },
  '/(app)/platform/settings/resource-usage/+page.svelte': {
    'usage-rows': { ...OWNER_READY, usage: usage({}), warnings: [] },
    'usage-truncated': {
      ...OWNER_READY,
      usage: usage({ truncated: true, auditStorageByOrg: [] }),
      warnings: [],
    },
    'usage-critical': {
      ...OWNER_READY,
      usage: usage({
        orgs: { current: 10, limit: 10 },
        storageBytes: { current: 96, limit: 100 },
        auditLogEntries: { current: 91, limit: 100 },
        auditLogStorage: {
          currentBytes: 49_000_000_000,
          limitBytes: 50_000_000_000,
          utilizationPct: 98,
        },
      }),
      warnings: [],
    },
    'usage-warnings': {
      ...OWNER_READY,
      usage: usage({}),
      warnings: ['audit_storage_critical', 'key_custody_risk', 'unknown_warning'],
    },
    'usage-thresholds': {
      ...OWNER_READY,
      usage: usage({
        orgs: { current: 17, limit: 20 },
        usersPerOrg: [
          { orgId: 'org-a', current: 40, limit: 50 },
          { orgId: 'org-b', current: 46, limit: 50 },
          { orgId: 'org-c', current: 49, limit: 50 },
          { orgId: 'org-d', current: 5, limit: 50 },
          { orgId: 'org-e', current: 5, limit: null },
        ],
        auditLogEntries: { current: 1_234_567, limit: 2_000_000 },
        storageBytes: { current: 900_000, limit: 1_000_000 },
        allocationIncludesUnlimitedOrgs: false,
        observedPhysicalToLogicalRatio: null,
      }),
      warnings: [],
    },
    'usage-empty-orgs': {
      ...OWNER_READY,
      usage: usage({ auditStorageByOrg: [] }),
      warnings: [],
    },
    'usage-error': { ...OWNER_READY, usage: null, warnings: [], errorMessage: 'usage unavailable' },
    'usage-denied': { ...GATES_SHUT, ...NEGATIVES_OFF, usage: null, warnings: [] },
  },
  '/(app)/platform/backups/+page.svelte': {
    'backups-rows': { ...OWNER_READY, backups: BACKUPS },
    'backups-empty': { ...OWNER_READY, backups: [] },
    'backups-error-empty': { ...OWNER_READY, backups: [], errorMessage: 'backups unavailable' },
    'backups-error-rows': { ...OWNER_READY, backups: BACKUPS, errorMessage: 'backups stale' },
    'backups-denied': { ...GATES_SHUT, ...NEGATIVES_OFF },
  },
  '/(app)/projects/+page.svelte': {
    'projects-mixed': {
      ...OWNER_READY,
      includeArchived: true,
      projects: { items: PROJECT_ITEMS, total: 5, page: 1, limit: 100, hasNext: false },
    },
    'projects-active-only': {
      ...OWNER_READY,
      includeArchived: false,
      projects: { items: PROJECT_ITEMS.slice(0, 3), total: 3, page: 1, limit: 100, hasNext: false },
    },
    'projects-empty': {
      ...OWNER_READY,
      projects: { items: [], total: 0, page: 1, limit: 100, hasNext: false },
    },
  },
  '/(app)/settings/users/[userId]/erasure/[requestId]/+page.svelte': {
    'erasure-pending-owner': {
      ...ERASURE_BASE,
      state: 'pending',
      orgRole: 'owner',
      piiInventory: ERASURE_INVENTORY,
    },
    'erasure-pending-admin': {
      ...ERASURE_BASE,
      state: 'pending',
      orgRole: 'admin',
      piiInventory: ERASURE_INVENTORY,
    },
    'erasure-pending-no-email': {
      ...ERASURE_BASE,
      state: 'pending',
      orgRole: 'owner',
      userEmail: null,
      piiInventory: ERASURE_INVENTORY,
    },
    'erasure-pending-no-inventory': {
      ...ERASURE_BASE,
      state: 'pending',
      orgRole: 'owner',
      piiInventory: null,
    },
    'erasure-completed': { ...ERASURE_BASE, state: 'completed', report: ERASURE_REPORT },
    'erasure-completed-no-audit-id': {
      ...ERASURE_BASE,
      state: 'completed',
      report: { ...ERASURE_REPORT, auditEventId: null, piiRetained: [], piiRemoved: [] },
    },
  },
  '/(app)/notifications/+page.svelte': {
    'inbox-first-page': { ...NOTIFICATIONS_PAGE, hasNext: true },
    'inbox-middle-page': { ...NOTIFICATIONS_PAGE, page: 2, hasNext: true, status: 'read' },
    'inbox-last-page': { ...NOTIFICATIONS_PAGE, page: 3, status: 'unread' },
    'inbox-single-page': NOTIFICATIONS_PAGE,
    'inbox-empty-all': { ...NOTIFICATIONS_PAGE, notifications: [] },
    'inbox-empty-unread': { ...NOTIFICATIONS_PAGE, notifications: [], status: 'unread' },
  },
  '/(app)/settings/extensions/+page.svelte': {
    'extensions-denied': { allowed: false },
    'extensions-mfa-required': { ...EXTENSIONS_ALLOWED, mfaRequired: true },
    'extensions-error': { ...EXTENSIONS_ALLOWED, errorMessage: 'status unavailable' },
    'extensions-loaded': {
      ...EXTENSIONS_ALLOWED,
      manifest: EXTENSION_MANIFEST,
      healthStatus: 'loaded',
    },
    'extensions-loaded-bare': {
      ...EXTENSIONS_ALLOWED,
      manifest: { ...EXTENSION_MANIFEST, packageVersion: null, capabilities: [] },
      healthStatus: 'loaded',
    },
    'extensions-loaded-audit-only': {
      ...EXTENSIONS_ALLOWED,
      manifest: { ...EXTENSION_MANIFEST, capabilities: ['audit-event-source'] },
      healthStatus: 'loaded',
    },
    'extensions-load-failed': { ...EXTENSIONS_ALLOWED, healthStatus: 'load_failed' },
    'extensions-not-configured': EXTENSIONS_ALLOWED,
  },
  '/(app)/projects/[projectId]/credentials/new/+page.svelte': {
    'new-credential-member': { ...OWNER_READY, orgRole: 'member', projectId: 'p-1' },
    'new-credential-viewer': { ...OWNER_READY, orgRole: 'viewer', projectId: 'p-1' },
  },
  '/(app)/settings/external-identities/+page.svelte': {
    'identities-linked': {
      ...OWNER_READY,
      identities: EXTERNAL_IDENTITIES,
      orgUsers: EXTERNAL_IDENTITY_USERS,
    },
    'identities-empty': { ...OWNER_READY, identities: [], orgUsers: EXTERNAL_IDENTITY_USERS },
  },
  '/(app)/settings/audit/access-report/+page.svelte': {
    'report-current': ACCESS_REPORT_PAGE,
    'report-as-of-next': {
      ...ACCESS_REPORT_PAGE,
      asOf: '2026-10-01',
      page: 2,
      report: { ...ACCESS_REPORT, hasNext: true },
    },
    'report-first-page-next': {
      ...ACCESS_REPORT_PAGE,
      report: { ...ACCESS_REPORT, hasNext: true },
    },
    'report-empty': { ...ACCESS_REPORT_PAGE, report: { ...ACCESS_REPORT, users: [] } },
    'report-load-error': {
      ...ACCESS_REPORT_PAGE,
      report: null,
      errorMessage: 'report unavailable',
    },
    'report-not-generated': { ...ACCESS_REPORT_PAGE, report: null },
  },
  '/(app)/projects/[projectId]/credentials/import/+page.svelte': {
    'import-allowed': { ...OWNER_READY, canImport: true, projectId: 'p-1' },
    'import-denied': { ...OWNER_READY, canImport: false, projectId: 'p-1' },
  },
  '/(app)/platform/settings/orgs/+page.svelte': {
    'orgs-listed': { ...OWNER_READY, orgs: PLATFORM_ORGS },
    'orgs-empty': { ...OWNER_READY, orgs: [] },
    'orgs-empty-with-error': { ...OWNER_READY, orgs: [], errorMessage: 'orgs unavailable' },
    'orgs-listed-with-error': {
      ...OWNER_READY,
      orgs: PLATFORM_ORGS,
      errorMessage: 'orgs unavailable',
    },
  },
  '/(app)/projects/[projectId]/status-page/+page.svelte': {
    'status-page-services-selected': STATUS_PAGE_BASE,
    'status-page-one-selected': {
      ...STATUS_PAGE_BASE,
      config: {
        ...STATUS_PAGE_BASE.config,
        services: [{ serviceId: 'se-3', displayName: 'Payments' }],
      },
    },
    'status-page-none-selected': {
      ...STATUS_PAGE_BASE,
      config: { ...STATUS_PAGE_BASE.config, services: [] },
    },
    'status-page-no-endpoints': {
      ...STATUS_PAGE_BASE,
      serviceEndpoints: [],
      config: { ...STATUS_PAGE_BASE.config, services: [] },
    },
    'status-page-capability-denied': {
      ...STATUS_PAGE_BASE,
      capabilities: { 'monitoring.public-status-page': false },
    },
    'status-page-disabled': {
      ...STATUS_PAGE_BASE,
      config: { enabled: false, token: null, legacyToken: false, services: [] },
    },
  },
  '/(app)/projects/[projectId]/members/+page.svelte': {
    'members-owner-transfer': MEMBERS_PAGE,
    'members-no-transfer': { ...MEMBERS_PAGE, canTransferOwnership: false },
    'members-only-owner': {
      ...MEMBERS_PAGE,
      members: PROJECT_MEMBERS.slice(0, 1),
    },
    'members-empty': { ...MEMBERS_PAGE, members: [] },
    'members-no-manage-members': { ...MEMBERS_PAGE, canManageMembers: false },
    'members-read-only': { ...MEMBERS_PAGE, canManage: false, canManageMembers: false },
  },
  '/(auth)/handoff/+page.svelte': {
    'handoff-with-origin': { centralizeMeOrigin: 'https://app.centralizeme.example' },
    'handoff-without-origin': { centralizeMeOrigin: null },
  },
}

const children = createRawSnippet(() => ({ render: () => '<span data-child></span>' }))

function normalize(root: Element): string {
  return serializeWithoutNoise(root).replace(/\s+/g, ' ').trim()
}

function outcome(
  component: never,
  isLayout: boolean,
  variant: (typeof VARIANTS)[keyof typeof VARIANTS]
): string {
  try {
    const { container } = render(component, {
      data: full('r', { origin: 'https://vault.example.com', ...variant.data }),
      form: variant.form === null ? null : full(variant.form),
      ...(isLayout ? { children } : {}),
    } as never)
    return normalize(container)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `THROWS: ${message.split('\n')[0]?.slice(0, 120) ?? ''}`
  } finally {
    cleanup()
  }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('route render data-rich snapshot (Story 69.5 AC-5)', () => {
  it('covers every one of the 73 route files', () => {
    expect(Object.keys(routes)).toHaveLength(73)
  })

  it('renders every route file with full data exactly as before the componentization', async () => {
    previewState.project = {
      id: 'preview',
      name: 'Preview Project',
      description: 'A temporary preview of the project-centered dashboard.',
      persisted: false,
      dashboard: { suggestedActions: [] },
    }
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-04T12:00:00.000Z'))
    const result: Record<string, string> = {}
    for (const [file, module] of Object.entries(routes).sort(([a], [b]) => a.localeCompare(b))) {
      const isLayout = !file.endsWith('+page.svelte') && !file.endsWith('+error.svelte')
      pageState.data =
        file === './(app)/projects/+page.svelte' ? { user: { orgRole: 'member' } } : {}
      for (const [name, variant] of Object.entries(VARIANTS)) {
        result[`${file} [${name}]`] = outcome(module.default, isLayout, variant)
      }
      const branches = { ...BRANCHES[file.slice(1)], ...HANDCRAFTED[file.slice(1)] }
      for (const [name, data] of Object.entries(branches)) {
        result[`${file} [${name}]`] = outcome(module.default, isLayout, { data, form: null })
      }
    }
    previewState.project = null
    const preview = routes['./(app)/projects/preview/+page.svelte']
    result['./(app)/projects/preview/+page.svelte [no-project]'] = outcome(
      preview?.default as never,
      false,
      VARIANTS.full
    )
    await expect(`${JSON.stringify(result, null, 2)}\n`).toMatchFileSnapshot(
      './route-render-data.snapshot.json'
    )
    const branchCount = [BRANCHES, HANDCRAFTED].reduce(
      (n, table) => n + Object.values(table).reduce((m, entry) => m + Object.keys(entry).length, 0),
      0
    )
    expect(Object.keys(result)).toHaveLength(72 * 5 + 1 + branchCount)
    // Measured: 1.7 s alone and 5.7 s in a full parallel run, so the default 5 s is not enough.
  }, 60_000)
})
