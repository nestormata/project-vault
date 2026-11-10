import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { isOrgMemberForScheduledTask, withScheduledTaskOrganization } from './org-membership.js'

const resolveActiveOrgRole = vi.hoisted(() => vi.fn())

vi.mock('../plugins/authenticate.js', () => ({ resolveActiveOrgRole }))

const organizationId = randomUUID()
const userId = randomUUID()

describe('scheduled membership identifier validation', () => {
  it.each(['', 'not-a-uuid'])(
    'rejects invalid task scope %j before querying',
    async (invalidId) => {
      resolveActiveOrgRole.mockResolvedValue('member')

      await expect(
        withScheduledTaskOrganization(invalidId, () =>
          isOrgMemberForScheduledTask({ organizationId: invalidId, userId })
        )
      ).resolves.toEqual(expect.objectContaining({ status: 'unavailable' }))
      expect(resolveActiveOrgRole).not.toHaveBeenCalled()
    }
  )

  it.each(['', 'not-a-uuid'])('rejects invalid user id %j before querying', async (invalidId) => {
    resolveActiveOrgRole.mockResolvedValue('member')

    await expect(
      withScheduledTaskOrganization(organizationId, () =>
        isOrgMemberForScheduledTask({ organizationId, userId: invalidId })
      )
    ).resolves.toEqual(expect.objectContaining({ status: 'unavailable' }))
    expect(resolveActiveOrgRole).not.toHaveBeenCalled()
  })
})
