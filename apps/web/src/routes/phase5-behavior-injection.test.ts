import { beforeEach, describe, expect, it, vi } from 'vitest'
import { error } from '@sveltejs/kit'
import { ApiClientError } from '$lib/api/client.js'
import { INJECTION_POINTS } from '$lib/components/composition/injection-points.js'

// Story 69.4 AC-5: behavior injection works on the three pages, with kit-shaped tables standing in
// for what a composition kit generates for `virtual:pv-inject-behavior`. The tables put a
// contribution load at one NEW region point per page and an action at two of them.

const spies = vi.hoisted(() => ({
  auditLoad: vi.fn(),
  notificationsLoad: vi.fn(),
  membersLoad: vi.fn(),
  membersAction: vi.fn(),
  notificationsAction: vi.fn(),
  listAuditEvents: vi.fn(),
  getNotificationPreferences: vi.fn(),
  listProjectMembers: vi.fn(),
  listInvitations: vi.fn(),
}))

vi.mock('virtual:pv-inject-behavior', () => ({
  loads: {
    '/(app)/settings/audit#page': [
      { point: 'settings.audit.results', contributions: [{ order: 0, load: spies.auditLoad }] },
    ],
    '/(app)/settings/notifications#page': [
      {
        point: 'settings.notifications.channels',
        contributions: [{ order: 0, load: spies.notificationsLoad }],
      },
    ],
    '/(app)/projects/[projectId]/members#page': [
      { point: 'project.members.access', contributions: [{ order: 0, load: spies.membersLoad }] },
    ],
  },
  actions: {
    '/(app)/settings/notifications#page': {
      'settings.notifications.channels.save': {
        point: 'settings.notifications.channels',
        name: 'save',
        run: spies.notificationsAction,
      },
    },
    '/(app)/projects/[projectId]/members#page': {
      'project.members.access.touch': {
        point: 'project.members.access',
        name: 'touch',
        run: spies.membersAction,
      },
    },
  },
}))
vi.mock('$lib/api/audit.js', () => ({ listAuditEvents: spies.listAuditEvents }))
vi.mock('$lib/api/notifications.js', () => ({
  getNotificationPreferences: spies.getNotificationPreferences,
  getOrgNotificationRouting: vi.fn(),
  patchNotificationPreferences: vi.fn(),
  postAdminNotificationTest: vi.fn(),
  putOrgNotificationRouting: vi.fn(),
}))
vi.mock('$lib/api/invitations.js', () => ({ listInvitations: spies.listInvitations }))
vi.mock('$lib/api/org-users.js', () => ({ listProjectMembers: spies.listProjectMembers }))

import { load as auditLoad } from './(app)/settings/audit/+page.server.js'
import {
  load as notificationsLoad,
  actions as notificationsActions,
} from './(app)/settings/notifications/+page.server.js'
import {
  load as membersLoad,
  actions as membersActions,
} from './(app)/projects/[projectId]/members/+page.server.js'

type AnyLoad = (event: never) => Promise<Record<string, unknown>>

function eventFor(role: string, extra: Record<string, unknown> = {}) {
  return {
    fetch: vi.fn(),
    url: new URL('http://localhost/x'),
    params: { projectId: 'p-1' },
    locals: { user: { userId: 'u-1', orgRole: role, mfaEnrolled: true } },
    ...extra,
  }
}

function run(load: unknown, event: unknown): Promise<Record<string, unknown>> {
  return (load as AnyLoad)(event as never)
}

beforeEach(() => {
  for (const spy of Object.values(spies)) spy.mockReset()
  spies.auditLoad.mockResolvedValue({ marker: 'audit' })
  spies.notificationsLoad.mockResolvedValue({ marker: 'notifications' })
  spies.membersLoad.mockResolvedValue({ marker: 'members' })
  spies.listAuditEvents.mockResolvedValue({
    data: [],
    page: 1,
    limit: 20,
    total: 0,
    hasNext: false,
  })
  spies.getNotificationPreferences.mockResolvedValue([])
  spies.listProjectMembers.mockResolvedValue([])
  spies.listInvitations.mockResolvedValue([])
})

describe('phase 5 behavior injection (Story 69.4 AC-5)', () => {
  it('AC-5.1: a contribution load runs after PV load with the same event and reaches __inject', async () => {
    const event = eventFor('member')
    const order: string[] = []
    spies.getNotificationPreferences.mockImplementation(async () => {
      order.push('pv')
      return []
    })
    spies.notificationsLoad.mockImplementation(async (received: unknown) => {
      order.push('contribution')
      expect(received).toBe(event)
      return { marker: 'notifications' }
    })
    const data = await run(notificationsLoad, event)
    expect(order).toEqual(['pv', 'contribution'])
    expect(data['__inject']).toEqual({
      'settings.notifications.channels': [{ marker: 'notifications' }],
    })
  })

  it('AC-5.2: an injected action is exposed under <point>.<name> and runs through the wrapper', async () => {
    spies.membersAction.mockResolvedValue({ touched: true })
    const key = 'project.members.access.touch'
    const actions = membersActions as unknown as Record<string, (event: never) => Promise<unknown>>
    expect(Object.keys(actions)).toEqual([key])
    const event = eventFor('owner')
    await expect(Object.values(actions)[0]?.(event as never)).resolves.toEqual({ touched: true })
    expect(spies.membersAction).toHaveBeenCalledWith(event)
  })

  it('AC-5.3 (Story 69.7): a denied caller runs no contribution load; an allowed one runs it once', async () => {
    const data = await run(auditLoad, eventFor('member'))
    expect(data['allowed']).toBe(false)
    expect(spies.listAuditEvents).not.toHaveBeenCalled()
    expect(spies.auditLoad).not.toHaveBeenCalled()
    expect(data['__inject']).toEqual({ 'settings.audit.results': [null] })
    const allowed = await run(auditLoad, eventFor('owner'))
    expect(allowed['allowed']).toBe(true)
    expect(spies.auditLoad).toHaveBeenCalledOnce()
  })

  it('AC-5.4: an error thrown by PV load short-circuits, no contribution load runs', async () => {
    spies.getNotificationPreferences.mockImplementation(async () => {
      error(500, 'boom')
    })
    await expect(run(notificationsLoad, eventFor('member'))).rejects.toMatchObject({ status: 500 })
    expect(spies.notificationsLoad).not.toHaveBeenCalled()
  })

  it.each([403, 404])(
    'AC-5.4 (Story 69.7): a %i from the member list is a PV denial: no contribution load, marker stripped',
    async (status) => {
      spies.listProjectMembers.mockRejectedValue(new ApiClientError(status, null, 'denied'))
      spies.listInvitations.mockRejectedValue(new ApiClientError(status, null, 'denied'))
      const data = await run(membersLoad, eventFor('owner'))
      expect(data['members']).toEqual([])
      expect(data['invitations']).toEqual([])
      expect('skipInjectedLoads' in data).toBe(false)
      expect(spies.membersLoad).not.toHaveBeenCalled()
      expect(data['__inject']).toEqual({ 'project.members.access': [null] })
    }
  )

  it('AC-5.4: a 5xx or network failure is not a denial: degrade to [] and the load still runs', async () => {
    spies.listProjectMembers.mockRejectedValue(new ApiClientError(500, null, 'boom'))
    const data = await run(membersLoad, eventFor('owner'))
    expect(data['members']).toEqual([])
    expect(spies.membersLoad).toHaveBeenCalledOnce()
    spies.listProjectMembers.mockRejectedValue(new Error('network'))
    await run(membersLoad, eventFor('owner'))
    expect(spies.membersLoad).toHaveBeenCalledTimes(2)
  })

  it('AC-5.4: a project admin who is only an org member loads the list and contributions run', async () => {
    spies.listProjectMembers.mockResolvedValue([{ userId: 'u-1', role: 'admin' }])
    const data = await run(membersLoad, eventFor('member'))
    expect(data['canManageMembers']).toBe(true)
    expect(spies.membersLoad).toHaveBeenCalledOnce()
  })

  it('AC-6 cross-tenant: org B user asking for org A projectId gets 0 contribution loads', async () => {
    spies.listProjectMembers.mockRejectedValue(new ApiClientError(404, null, 'not found'))
    await run(membersLoad, eventFor('member', { params: { projectId: 'org-a-project' } }))
    expect(spies.membersLoad).not.toHaveBeenCalled()
  })

  it.each([
    ['settings.audit.results', auditLoad, spies.auditLoad, 'owner'],
    ['settings.notifications.channels', notificationsLoad, spies.notificationsLoad, 'member'],
    ['project.members.access', membersLoad, spies.membersLoad, 'owner'],
  ])(
    'AC-5.6: a throwing load at %s surfaces the point and the error name only',
    async (point, load, spy, role) => {
      spy.mockRejectedValue(new TypeError('secret-user-value'))
      const failure = await run(load, eventFor(role)).catch((reason: unknown) => reason)
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toBe(`injection "${point}" load failed: TypeError`)
      expect((failure as Error).cause).toBeInstanceOf(TypeError)
    }
  )

  it.each([
    ['settings.notifications.channels', 'save', notificationsActions, spies.notificationsAction],
    ['project.members.access', 'touch', membersActions, spies.membersAction],
  ])(
    'AC-5.6: a throwing action at %s wraps the point, name and error name',
    async (point, name, actions, spy) => {
      spy.mockRejectedValue(new RangeError('secret-user-value'))
      const table = actions as unknown as Record<string, (event: never) => Promise<unknown>>
      const failure = await table[`${point}.${name}`]?.(eventFor('owner') as never).catch(
        (reason: unknown) => reason
      )
      expect((failure as Error).message).toBe(
        `injection "${point}" action "${name}" failed: RangeError`
      )
    }
  )

  it('AC-5.7: no own action key of the three pages starts with a registered point name', () => {
    const ownKeys = ['updatePreference', 'updateRouting', 'sendTest']
    const names = INJECTION_POINTS.map((point) => point.name)
    for (const key of ownKeys) {
      expect(Object.keys(notificationsActions as object)).toContain(key)
      expect(names.some((name) => key.startsWith(`${name}.`))).toBe(false)
    }
  })
})
