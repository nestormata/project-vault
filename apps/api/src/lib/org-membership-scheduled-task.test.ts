import { describe, expect, it, vi } from 'vitest'
import { isOrgMemberForScheduledTask, withScheduledTaskOrganization } from './org-membership.js'

const isOrgMember = vi.hoisted(() => vi.fn())

vi.mock('../plugins/authenticate.js', () => ({
  resolveActiveOrgRole: isOrgMember,
}))

describe('scheduled-task organization membership scope', () => {
  it('fails unavailable outside a PV scheduled-task invocation without querying membership', async () => {
    isOrgMember.mockResolvedValue('member')

    await expect(
      isOrgMemberForScheduledTask({ organizationId: 'org-a', userId: 'user-a' })
    ).resolves.toEqual({ status: 'unavailable', reason: 'membership_scope_unavailable' })
    expect(isOrgMember).not.toHaveBeenCalled()
  })

  it('answers only for the organization bound by PV to the current task', async () => {
    isOrgMember.mockResolvedValue('member')

    await withScheduledTaskOrganization('org-a', async () => {
      await expect(
        isOrgMemberForScheduledTask({ organizationId: 'org-a', userId: 'user-a' })
      ).resolves.toEqual({ status: 'allowed' })
      await expect(
        isOrgMemberForScheduledTask({ organizationId: 'org-b', userId: 'user-a' })
      ).resolves.toEqual({ status: 'unavailable', reason: 'membership_scope_mismatch' })
    })

    expect(isOrgMember).toHaveBeenCalledTimes(1)
    expect(isOrgMember).toHaveBeenCalledWith('user-a', 'org-a')
  })

  it('keeps concurrent task organizations isolated across asynchronous work', async () => {
    isOrgMember.mockImplementation(async (userId: string, organizationId: string) => {
      await new Promise((resolve) => setTimeout(resolve, organizationId === 'org-a' ? 5 : 1))
      return `${userId}:${organizationId}`
    })

    const results = await Promise.all([
      withScheduledTaskOrganization('org-a', () =>
        isOrgMemberForScheduledTask({ organizationId: 'org-a', userId: 'user-a' })
      ),
      withScheduledTaskOrganization('org-b', () =>
        isOrgMemberForScheduledTask({ organizationId: 'org-b', userId: 'user-b' })
      ),
    ])

    expect(results).toEqual([{ status: 'allowed' }, { status: 'allowed' }])
    expect(isOrgMember.mock.calls).toEqual([
      ['user-a', 'org-a'],
      ['user-b', 'org-b'],
    ])
  })

  it('maps membership lookup failures to unavailable without leaking the error', async () => {
    isOrgMember.mockRejectedValue(new Error('database detail'))
    const logger = { info: vi.fn(), warn: vi.fn() }

    await withScheduledTaskOrganization('org-a', async () => {
      await expect(
        isOrgMemberForScheduledTask(
          { organizationId: 'org-a', userId: 'user-a' },
          { extensionName: 'com.example.test', logger }
        )
      ).resolves.toEqual({ status: 'unavailable', reason: 'membership_check_failed' })
    })
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error', extensionName: 'com.example.test' }),
      'scheduled-task membership check recorded'
    )
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('database detail')
  })

  it('applies a per-extension in-flight cap and records the refused call', async () => {
    let resolveLookup: ((role: string) => void) | undefined
    isOrgMember.mockImplementation(() => new Promise((resolve) => (resolveLookup = resolve)))
    const logger = { info: vi.fn(), warn: vi.fn() }
    const hostContext = { extensionName: 'com.example.limited', logger, maxInFlight: 1 }

    const first = withScheduledTaskOrganization('org-a', () =>
      isOrgMemberForScheduledTask({ organizationId: 'org-a', userId: 'user-a' }, hostContext)
    )
    await expect(
      withScheduledTaskOrganization('org-a', () =>
        isOrgMemberForScheduledTask({ organizationId: 'org-a', userId: 'user-b' }, hostContext)
      )
    ).resolves.toEqual({ status: 'unavailable', reason: 'membership_check_rate_limited' })
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ extensionName: 'com.example.limited' }),
      'scheduled-task membership check was rate limited'
    )
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error', organizationId: 'org-a' }),
      'scheduled-task membership check recorded'
    )

    resolveLookup?.('member')
    await expect(first).resolves.toEqual({ status: 'allowed' })
  })
})
