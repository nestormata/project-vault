import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { isOrgMemberForScheduledTask, withScheduledTaskOrganization } from './org-membership.js'

const isOrgMember = vi.hoisted(() => vi.fn())
const ORG_A = randomUUID()
const ORG_B = randomUUID()
const USER_A = randomUUID()
const USER_B = randomUUID()

vi.mock('../plugins/authenticate.js', () => ({
  resolveActiveOrgRole: isOrgMember,
}))

describe('scheduled-task organization membership scope', () => {
  it('fails unavailable outside a PV scheduled-task invocation without querying membership', async () => {
    isOrgMember.mockResolvedValue('member')

    await expect(
      isOrgMemberForScheduledTask({ organizationId: ORG_A, userId: USER_A })
    ).resolves.toEqual({ status: 'unavailable', reason: 'membership_scope_unavailable' })
    expect(isOrgMember).not.toHaveBeenCalled()
  })

  it('answers only for the organization bound by PV to the current task', async () => {
    isOrgMember.mockResolvedValue('member')

    await withScheduledTaskOrganization(ORG_A, async () => {
      await expect(
        isOrgMemberForScheduledTask({ organizationId: ORG_A, userId: USER_A })
      ).resolves.toEqual({ status: 'allowed' })
      await expect(
        isOrgMemberForScheduledTask({ organizationId: ORG_B, userId: USER_A })
      ).resolves.toEqual({ status: 'unavailable', reason: 'membership_scope_mismatch' })
    })

    expect(isOrgMember).toHaveBeenCalledTimes(1)
    expect(isOrgMember).toHaveBeenCalledWith(USER_A, ORG_A)
  })

  it('keeps concurrent task organizations isolated across asynchronous work', async () => {
    isOrgMember.mockImplementation(async (userId: string, organizationId: string) => {
      await new Promise((resolve) => setTimeout(resolve, organizationId === ORG_A ? 5 : 1))
      return `${userId}:${organizationId}`
    })

    const results = await Promise.all([
      withScheduledTaskOrganization(ORG_A, () =>
        isOrgMemberForScheduledTask({ organizationId: ORG_A, userId: USER_A })
      ),
      withScheduledTaskOrganization(ORG_B, () =>
        isOrgMemberForScheduledTask({ organizationId: ORG_B, userId: USER_B })
      ),
    ])

    expect(results).toEqual([{ status: 'allowed' }, { status: 'allowed' }])
    expect(isOrgMember.mock.calls).toEqual([
      [USER_A, ORG_A],
      [USER_B, ORG_B],
    ])
  })

  it('maps membership lookup failures to unavailable without leaking the error', async () => {
    isOrgMember.mockRejectedValue(new Error('database detail'))
    const logger = { info: vi.fn(), warn: vi.fn() }

    await withScheduledTaskOrganization(ORG_A, async () => {
      await expect(
        isOrgMemberForScheduledTask(
          { organizationId: ORG_A, userId: USER_A },
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

    const first = withScheduledTaskOrganization(ORG_A, () =>
      isOrgMemberForScheduledTask({ organizationId: ORG_A, userId: USER_A }, hostContext)
    )
    await expect(
      withScheduledTaskOrganization(ORG_A, () =>
        isOrgMemberForScheduledTask({ organizationId: ORG_A, userId: USER_B }, hostContext)
      )
    ).resolves.toEqual({ status: 'unavailable', reason: 'membership_check_rate_limited' })
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ extensionName: 'com.example.limited' }),
      'scheduled-task membership check was rate limited'
    )
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error', organizationId: ORG_A }),
      'scheduled-task membership check recorded'
    )

    resolveLookup?.('member')
    await expect(first).resolves.toEqual({ status: 'allowed' })
  })
})
