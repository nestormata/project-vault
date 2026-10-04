// @pv-not-guard oracle of PV's own un-composed markup, valid only on PV's tree
import { cleanup, fireEvent, render } from '@testing-library/svelte'
import { tick, type ComponentProps } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serializeWithoutNoise } from '$lib/test/dom.js'
import { appLayoutData, projectLayoutData } from '$lib/test/page-data.js'

// Story 69.4 AC-7.1: the characterization oracle for the three pages that get region points
// (settings audit, settings notifications, project members). It renders each page with REALISTIC
// data (not the permissive proxy of route-render-snapshot) for the variants the story lists and
// snapshots the markup, normalized only by `serializeWithoutNoise` (comment nodes and script
// bodies). The snapshot was recorded from `main` @ e3969abe BEFORE any component was extracted and
// is committed first; after the refactor the same text must come out. Never regenerate it: the only
// legitimate change is a deliberate, signed-off markup change in a later story.

const changeProjectRoleMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/audit.js', () => ({
  verifyAuditRange: vi.fn(),
  triggerAuditExport: vi.fn(),
  getAuditExportStatus: vi.fn(),
  auditExportDownloadUrl: (jobId: string) => `/api/v1/org/audit/exports/${jobId}/download`,
}))
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(async () => {}) }))
vi.mock('$lib/api/invitations.js', () => ({
  createInvitation: vi.fn(),
  revokeInvitation: vi.fn(),
}))
vi.mock('$lib/api/org-users.js', () => ({
  changeProjectRole: changeProjectRoleMock,
  removeProjectMember: vi.fn(),
  transferOwnership: vi.fn(),
}))

import AuditPage from './(app)/settings/audit/+page.svelte'
import NotificationsPage from './(app)/settings/notifications/+page.svelte'
import MembersPage from './(app)/projects/[projectId]/members/+page.svelte'

type AuditData = ComponentProps<typeof AuditPage>['data']
type AuditAllowed = Extract<AuditData, { allowed: true }>
type NotificationsProps = ComponentProps<typeof NotificationsPage>
type NotificationsData = NotificationsProps['data']
type MembersData = ComponentProps<typeof MembersPage>['data']

const NOW = new Date('2026-10-04T12:00:00.000Z')

function events(count: number): AuditAllowed['events'] {
  return [
    {
      id: 'evt-1',
      eventType: 'credential.access',
      actorDisplayName: 'Dana Smith',
      resourceId: 'cred-1',
      resourceType: 'credential',
      projectId: 'proj-1',
      ipAddress: '203.0.113.4',
      createdAt: '2026-06-14T10:03:00.000Z',
    },
    {
      id: 'evt-2',
      eventType: 'member.invited',
      actorDisplayName: 'Olivia Owner',
      resourceId: null,
      resourceType: null,
      projectId: null,
      ipAddress: null,
      createdAt: '2026-06-14T09:00:00.000Z',
    },
    {
      id: 'evt-3',
      eventType: 'credential.rotated',
      actorDisplayName: 'Adam Admin',
      resourceId: 'cred-2',
      resourceType: 'credential',
      projectId: 'proj-2',
      ipAddress: '198.51.100.7',
      createdAt: '2026-06-13T18:30:00.000Z',
    },
  ].slice(0, count)
}

function auditOwner(overrides: Partial<AuditAllowed> = {}): AuditAllowed {
  return {
    ...appLayoutData(),
    orgRole: 'owner',
    allowed: true,
    filters: {},
    events: events(3),
    total: 3,
    limit: 20,
    page: 1,
    hasNext: false,
    errorMessage: null,
    ...overrides,
  }
}

const ALL_FILTERS = {
  eventType: 'credential.access',
  actorId: 'actor-9',
  resourceId: 'cred-1',
  projectId: 'proj-1',
  from: '2026-06-01',
  to: '2026-06-30',
}

const PREFERENCES: NotificationsData['preferences'] = [
  {
    alertType: 'credential.expiry',
    channel: 'email',
    frequency: 'immediate',
    minSeverity: 'warning',
  },
  {
    alertType: 'credential.expiry',
    channel: 'slack',
    frequency: 'digest_daily',
    minSeverity: 'info',
  },
  {
    alertType: 'credential.rotated',
    channel: 'inbox',
    frequency: 'immediate',
    minSeverity: 'critical',
  },
]

const ROUTING: NonNullable<NotificationsData['routing']> = [
  { alertType: 'credential.expiry', routeTo: 'owner' },
  { alertType: 'credential.rotated', routeTo: 'admin' },
]

function notifications(overrides: Partial<NotificationsData> = {}): NotificationsData {
  return {
    ...appLayoutData(),
    preferences: PREFERENCES,
    routing: null,
    isAdmin: false,
    canSendTest: false,
    ...overrides,
  }
}

const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OWNER = {
  userId: 'u-owner',
  email: 'owner@example.com',
  displayName: 'Owner',
  role: 'owner' as const,
}
const MEMBER = {
  userId: 'u-member',
  email: 'member@example.com',
  displayName: 'Member',
  role: 'member' as const,
}
const VIEWER = {
  userId: 'u-viewer',
  email: 'viewer@example.com',
  displayName: 'Viewer',
  role: 'viewer' as const,
}
const INVITATIONS: MembersData['invitations'] = [
  {
    id: 'inv-1',
    email: 'new@example.com',
    roleToAssign: 'member',
    expiresAt: '2026-10-07T12:00:00.000Z',
  },
  {
    id: 'inv-2',
    email: 'late@example.com',
    roleToAssign: 'viewer',
    expiresAt: '2026-10-04T18:00:00.000Z',
  },
  {
    id: 'inv-3',
    email: 'gone@example.com',
    roleToAssign: 'admin',
    expiresAt: '2026-10-01T12:00:00.000Z',
  },
] as MembersData['invitations']

function members(overrides: Partial<MembersData> = {}): MembersData {
  return {
    ...projectLayoutData(),
    projectId: PROJECT_ID,
    userId: 'u-owner',
    canManage: true as const,
    canManageMembers: true as const,
    canTransferOwnership: true as const,
    invitations: INVITATIONS,
    members: [OWNER, MEMBER, VIEWER],
    ...overrides,
  } as MembersData
}

const rendered = new Map<string, string>()

function snap(name: string, container: Element): void {
  rendered.set(name, serializeWithoutNoise(container))
}

async function renderAudit(name: string, data: AuditData): Promise<void> {
  const { container } = render(AuditPage, { props: { data } })
  snap(name, container)
  cleanup()
}

async function renderNotifications(
  name: string,
  data: NotificationsData,
  form: NotificationsProps['form'] = null
): Promise<void> {
  const { container } = render(NotificationsPage, { props: { data, form } })
  snap(name, container)
  cleanup()
}

async function renderMembers(name: string, data: MembersData): Promise<void> {
  const { container } = render(MembersPage, { props: { data } })
  snap(name, container)
  cleanup()
}

beforeEach(() => {
  rendered.clear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  // Locale/time-zone independent: the page renders `new Date(x).toLocaleString()`.
  vi.spyOn(Date.prototype, 'toLocaleString').mockImplementation(function (this: Date) {
    return `local(${this.toISOString()})`
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('phase 5 render oracle (Story 69.4 AC-7.1)', () => {
  it('renders the settings audit page exactly as it did before the region points existed', async () => {
    await renderAudit('audit: member', {
      ...appLayoutData(),
      orgRole: 'member',
      allowed: false,
    } as AuditData)
    await renderAudit('audit: admin', {
      ...appLayoutData(),
      orgRole: 'admin',
      allowed: false,
    } as AuditData)
    await renderAudit('audit: owner, 3 events, no filters', auditOwner())
    await renderAudit(
      'audit: owner, all six filters, page 2 of 3',
      auditOwner({
        filters: ALL_FILTERS,
        events: events(2),
        total: 45,
        page: 2,
        hasNext: true,
      })
    )
    await renderAudit(
      'audit: owner, empty result with filters',
      auditOwner({ filters: { eventType: 'nothing.here' }, events: [], total: 0 })
    )
    await renderAudit(
      'audit: owner, empty result without filters',
      auditOwner({ events: [], total: 0 })
    )
    await renderAudit(
      'audit: owner, load error',
      auditOwner({ events: [], total: 0, errorMessage: 'Could not load the audit log.' })
    )

    const { container, getAllByRole } = render(AuditPage, { props: { data: auditOwner() } })
    const rows = getAllByRole('row')
    await fireEvent.click(rows[1] as HTMLElement)
    await tick()
    snap('audit: owner, first row expanded', container)
    cleanup()

    expect(rendered.size).toBe(8)
    await expect(`${JSON.stringify(Object.fromEntries(rendered), null, 2)}\n`).toMatchFileSnapshot(
      './phase5-render-oracle.audit.snapshot.json'
    )
  })

  it('renders the settings notifications page exactly as it did before the region points existed', async () => {
    await renderNotifications('notifications: plain member', notifications())
    await renderNotifications(
      'notifications: admin with routing and canSendTest',
      notifications({ isAdmin: true, routing: ROUTING, canSendTest: true })
    )
    await renderNotifications(
      'notifications: admin with routing, no MFA',
      notifications({ isAdmin: true, routing: ROUTING, canSendTest: false })
    )
    await renderNotifications(
      'notifications: admin, routing null (403)',
      notifications({ isAdmin: true, routing: null, canSendTest: true })
    )
    for (const result of [
      { email: 'delivered', slack: 'delivered' },
      { email: 'failed', slack: 'not_configured' },
      { email: 'not_configured', slack: 'failed' },
    ] as const) {
      await renderNotifications(
        `notifications: admin, testResult ${result.email}/${result.slack}`,
        notifications({ isAdmin: true, routing: ROUTING, canSendTest: true }),
        { testResult: result } as NotificationsProps['form']
      )
    }
    await renderNotifications(
      'notifications: admin, form error',
      notifications({ isAdmin: true, routing: ROUTING, canSendTest: true }),
      { error: 'Too many test notifications. Try again later.' } as NotificationsProps['form']
    )
    await renderNotifications(
      'notifications: plain member, form error (cross-talk, shown nowhere)',
      notifications(),
      { error: 'Invalid frequency.' } as NotificationsProps['form']
    )

    expect(rendered.size).toBe(9)
    await expect(`${JSON.stringify(Object.fromEntries(rendered), null, 2)}\n`).toMatchFileSnapshot(
      './phase5-render-oracle.notifications.snapshot.json'
    )
  })

  it('renders the project members page exactly as it did before the region points existed', async () => {
    await renderMembers('members: org owner, members and invitations', members())
    await renderMembers(
      'members: plain org member, read-only',
      members({
        orgRole: 'member',
        userId: 'u-viewer',
        canManage: false as never,
        canManageMembers: false as never,
        canTransferOwnership: false as never,
        invitations: [],
        members: [OWNER, VIEWER],
      })
    )
    await renderMembers(
      'members: project admin who is only an org member',
      members({
        orgRole: 'member',
        userId: 'u-member',
        canManage: false as never,
        canManageMembers: true as never,
        canTransferOwnership: false as never,
        invitations: [],
      })
    )
    await renderMembers(
      'members: empty members and invitations',
      members({ members: [], invitations: [], canTransferOwnership: false as never })
    )

    const open = render(MembersPage, { props: { data: members() } })
    await fireEvent.click(open.getByRole('button', { name: 'Invite member' }))
    await tick()
    snap('members: invite form open', open.container)
    cleanup()

    let release: () => void = () => undefined
    changeProjectRoleMock.mockReturnValue(
      new Promise<void>((resolveBusy) => {
        release = resolveBusy
      })
    )
    const busy = render(MembersPage, { props: { data: members() } })
    const select = busy.getByLabelText('Role for member@example.com')
    await fireEvent.change(select, { target: { value: 'admin' } })
    await tick()
    snap('members: role select busy', busy.container)
    release()
    cleanup()

    expect(rendered.size).toBe(6)
    await expect(`${JSON.stringify(Object.fromEntries(rendered), null, 2)}\n`).toMatchFileSnapshot(
      './phase5-render-oracle.members.snapshot.json'
    )
  })
})
