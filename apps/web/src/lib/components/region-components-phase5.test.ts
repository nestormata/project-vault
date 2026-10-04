import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/svelte'
import { createRawSnippet, type Component } from 'svelte'
import { serializeWithoutNoise } from '$lib/test/dom.js'
import AuditPageHeader from './audit/AuditPageHeader.svelte'
import AuditRoleNotice from './audit/AuditRoleNotice.svelte'
import AuditErrorBanner from './audit/AuditErrorBanner.svelte'
import AuditSearchForm from './audit/AuditSearchForm.svelte'
import AuditResultsTable from './audit/AuditResultsTable.svelte'
import NotificationSettingsHeader from './notifications/NotificationSettingsHeader.svelte'
import NotificationPreferencesPanel from './notifications/NotificationPreferencesPanel.svelte'
import NotificationRoutingPanel from './notifications/NotificationRoutingPanel.svelte'
import NotificationTestPanel from './notifications/NotificationTestPanel.svelte'
import ProjectMembersHeader from './members/ProjectMembersHeader.svelte'
import ProjectTeamPanel from './members/ProjectTeamPanel.svelte'
import ProjectMembersNotice from './members/ProjectMembersNotice.svelte'
import ProjectInviteForm from './members/ProjectInviteForm.svelte'
import ProjectInvitationsTable from './members/ProjectInvitationsTable.svelte'

// Story 69.4 D7: every extracted region component is tested at the seam. The five audit components
// render the page's injection point as their `children`: it appears when given, and without it the
// markup is exactly PV's own. The nine others keep the container and the point in the page and are
// covered by the phase 5 render oracle plus the behaviour checks below.

afterEach(cleanup)

type AnyComponent = Component<Record<string, unknown>>

const marker = createRawSnippet(() => ({ render: () => '<span data-child="region"></span>' }))

function markup(component: AnyComponent, props: Record<string, unknown>): string {
  const { container } = render(component, { props })
  const html = serializeWithoutNoise(container)
  cleanup()
  return html
}

function withoutChildMarker(component: AnyComponent, props: Record<string, unknown>) {
  const { container } = render(component, { props: { ...props, children: marker } })
  const found = container.querySelectorAll('[data-child="region"]').length
  for (const node of container.querySelectorAll('[data-child="region"]')) node.remove()
  const html = serializeWithoutNoise(container)
  cleanup()
  return { found, html }
}

const AUDIT_FILTERS = { eventType: 'credential.access', from: '2026-06-01', to: '2026-06-30' }
const AUDIT_EVENT = {
  id: 'evt-1',
  eventType: 'credential.access',
  actorDisplayName: 'Dana Smith',
  resourceId: 'cred-1',
  resourceType: 'credential',
  projectId: 'proj-1',
  ipAddress: '203.0.113.4',
  createdAt: '2026-06-14T10:03:00.000Z',
}

const CHILDREN_CASES: [string, AnyComponent, Record<string, unknown>][] = [
  ['AuditPageHeader', AuditPageHeader as AnyComponent, {}],
  ['AuditRoleNotice (admin)', AuditRoleNotice as AnyComponent, { orgRole: 'admin' }],
  ['AuditRoleNotice (member)', AuditRoleNotice as AnyComponent, { orgRole: 'member' }],
  ['AuditErrorBanner (error)', AuditErrorBanner as AnyComponent, { message: 'Boom' }],
  ['AuditErrorBanner (none)', AuditErrorBanner as AnyComponent, { message: null }],
  [
    'AuditSearchForm',
    AuditSearchForm as AnyComponent,
    { filters: AUDIT_FILTERS, hasFilters: true },
  ],
  [
    'AuditResultsTable (rows)',
    AuditResultsTable as AnyComponent,
    { events: [AUDIT_EVENT], filters: {}, hasFilters: false, page: 2, total: 40, hasNext: true },
  ],
  [
    'AuditResultsTable (empty)',
    AuditResultsTable as AnyComponent,
    { events: [], filters: AUDIT_FILTERS, hasFilters: true, page: 1, total: 0, hasNext: false },
  ],
]

describe('audit region components render their injection point as children', () => {
  it.each(CHILDREN_CASES)(
    '%s: child shows once, and without it the markup is unchanged',
    (_n, c, p) => {
      const plain = markup(c, p)
      expect(plain).not.toContain('data-child')
      const given = withoutChildMarker(c, p)
      expect(given.found).toBe(1)
      expect(given.html).toBe(plain)
    }
  )

  it('AuditErrorBanner renders the alert only with a message', () => {
    expect(markup(AuditErrorBanner as AnyComponent, { message: null })).not.toContain(
      'role="alert"'
    )
    expect(markup(AuditErrorBanner as AnyComponent, { message: 'Boom' })).toContain('Boom')
  })

  it('AuditResultsTable shows the filtered empty state and toggles a row on click', async () => {
    const empty = markup(AuditResultsTable as AnyComponent, {
      events: [],
      filters: AUDIT_FILTERS,
      hasFilters: true,
      page: 1,
      total: 0,
      hasNext: false,
    })
    expect(empty).toContain('No audit events match these filters.')
    const { container, getAllByRole } = render(AuditResultsTable as AnyComponent, {
      props: {
        events: [AUDIT_EVENT],
        filters: {},
        hasFilters: false,
        page: 1,
        total: 1,
        hasNext: false,
      },
    })
    expect(container.querySelector('dl')).toBeNull()
    await fireEvent.click(getAllByRole('row')[1] as HTMLElement)
    expect(container.querySelector('dl')).not.toBeNull()
    await fireEvent.click(getAllByRole('row')[1] as HTMLElement)
    expect(container.querySelector('dl')).toBeNull()
  })

  it('AuditSearchForm blocks an inverted date range before submitting', async () => {
    const { container } = render(AuditSearchForm as AnyComponent, {
      props: { filters: { from: '2026-06-30', to: '2026-06-01' }, hasFilters: true },
    })
    const form = container.querySelector('form') as HTMLFormElement
    const submit = new Event('submit', { cancelable: true, bubbles: true })
    form.dispatchEvent(submit)
    await Promise.resolve()
    expect(submit.defaultPrevented).toBe(true)
  })
})

const PREFERENCE = {
  alertType: 'credential.expiry',
  channel: 'email',
  frequency: 'immediate',
  minSeverity: 'warning',
}

describe('notification region components', () => {
  it('renders the header links and title', () => {
    expect(markup(NotificationSettingsHeader as AnyComponent, {})).toContain(
      'Notification Preferences'
    )
  })

  it('renders one preference form per row posting updatePreference', () => {
    const { container } = render(NotificationPreferencesPanel as AnyComponent, {
      props: { preferences: [PREFERENCE, { ...PREFERENCE, channel: 'slack' }] },
    })
    expect(container.querySelectorAll('form[action="?/updatePreference"]')).toHaveLength(2)
    cleanup()
    const none = markup(NotificationPreferencesPanel as AnyComponent, { preferences: [] })
    expect(none).toContain('Personal Delivery Preferences')
  })

  it('renders one routing select per alert type', () => {
    const { container } = render(NotificationRoutingPanel as AnyComponent, {
      props: { routing: [{ alertType: 'credential.expiry', routeTo: 'owner' }] },
    })
    expect(container.querySelectorAll('select[name="routeTo_credential.expiry"]')).toHaveLength(1)
    expect(container.textContent).toContain('Save Routing')
  })

  it.each([
    [true, 'Send test notification'],
    [false, 'Enroll in MFA'],
  ])('test panel with canSendTest=%s shows %s', (canSendTest, text) => {
    const html = markup(NotificationTestPanel as AnyComponent, {
      canSendTest,
      testResult: undefined,
      error: undefined,
    })
    expect(html).toContain(text)
  })

  it('test panel prints per-channel results and the form error', () => {
    const html = markup(NotificationTestPanel as AnyComponent, {
      canSendTest: true,
      testResult: { email: 'delivered', slack: 'failed' },
      error: 'Too many',
    })
    expect(html).toContain('text-green-700')
    expect(html).toContain('text-red-700')
    expect(html).toContain('Too many')
  })
})

const OWNER = { userId: 'u1', email: 'owner@example.com', displayName: 'Owner', role: 'owner' }
const MEMBER = { userId: 'u2', email: 'member@example.com', displayName: 'Member', role: 'member' }

describe('project members region components', () => {
  it('header shows the Invite toggle only for a manager and calls back on click', async () => {
    const onToggleInvite = vi.fn()
    const { getByRole } = render(ProjectMembersHeader as AnyComponent, {
      props: { canManage: true, showInviteForm: false, onToggleInvite },
    })
    await fireEvent.click(getByRole('button', { name: 'Invite member' }))
    expect(onToggleInvite).toHaveBeenCalledOnce()
    cleanup()
    const hidden = render(ProjectMembersHeader as AnyComponent, {
      props: { canManage: false, showInviteForm: false, onToggleInvite },
    })
    expect(hidden.queryByRole('button')).toBeNull()
  })

  it('notice renders the read-only sentence', () => {
    expect(markup(ProjectMembersNotice as AnyComponent, {})).toContain(
      'Only project owners and admins can manage invitations.'
    )
  })

  it('team panel routes row actions to the page callbacks and shows the empty state', async () => {
    const onChangeRole = vi.fn()
    const onRemove = vi.fn()
    const onTransfer = vi.fn()
    const { getByRole, getByLabelText } = render(ProjectTeamPanel as AnyComponent, {
      props: {
        members: [OWNER, MEMBER],
        memberError: null,
        memberBusyId: null,
        canTransferOwnership: true,
        transferTarget: 'u2',
        onChangeRole,
        onRemove,
        onTransfer,
      },
    })
    await fireEvent.click(getByRole('button', { name: 'Remove' }))
    expect(onRemove).toHaveBeenCalledWith(MEMBER)
    await fireEvent.change(getByLabelText('Role for member@example.com'), {
      target: { value: 'admin' },
    })
    expect(onChangeRole).toHaveBeenCalledWith(MEMBER, 'admin')
    await fireEvent.click(getByRole('button', { name: 'Transfer' }))
    expect(onTransfer).toHaveBeenCalledOnce()
    cleanup()
    const empty = markup(ProjectTeamPanel as AnyComponent, {
      members: [],
      memberError: 'Nope',
      memberBusyId: null,
      canTransferOwnership: false,
      transferTarget: '',
      onChangeRole,
      onRemove,
      onTransfer,
    })
    expect(empty).toContain('No members yet.')
    expect(empty).toContain('role="alert"')
  })

  it('invite form shows the sending label while submitting and the error message', () => {
    const idle = markup(ProjectInviteForm as AnyComponent, {
      email: '',
      role: 'member',
      errorMessage: 'Enable MFA to invite teammates.',
      isSubmitting: false,
    })
    expect(idle).toContain('Send invite')
    expect(idle).toContain('Enable MFA to invite teammates.')
    const busy = markup(ProjectInviteForm as AnyComponent, {
      email: '',
      role: 'member',
      errorMessage: null,
      isSubmitting: true,
    })
    expect(busy).toContain('Sending...')
  })

  it('invitations table formats expiry, revokes through the callback and shows the empty row', async () => {
    const now = Date.now()
    const invitation = (id: string, offsetMs: number) => ({
      id,
      email: `${id}@example.com`,
      roleToAssign: 'member',
      expiresAt: new Date(now + offsetMs).toISOString(),
    })
    const onRevoke = vi.fn()
    const { container, getAllByRole } = render(ProjectInvitationsTable as AnyComponent, {
      props: {
        invitations: [
          invitation('soon', 3 * 60 * 60 * 1000 + 60_000),
          invitation('later', 3 * 24 * 60 * 60 * 1000 + 60_000),
          invitation('gone', -60_000),
        ],
        revokingId: 'gone',
        onRevoke,
      },
    })
    expect(container.textContent).toContain('expires in 3h')
    expect(container.textContent).toContain('expires in 3d')
    expect(container.textContent).toContain('expired')
    const buttons = getAllByRole('button')
    expect((buttons[2] as HTMLButtonElement).disabled).toBe(true)
    await fireEvent.click(buttons[0] as HTMLElement)
    expect(onRevoke).toHaveBeenCalledOnce()
    cleanup()
    expect(
      markup(ProjectInvitationsTable as AnyComponent, {
        invitations: [],
        revokingId: null,
        onRevoke,
      })
    ).toContain('No pending invitations.')
  })
})
