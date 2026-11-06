import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { isOrgMemberForScheduledTask, withScheduledTaskOrganization } from './org-membership.js'
import { raceWithTimeout } from './race-with-timeout.js'

const resolveActiveOrgRole = vi.hoisted(() => vi.fn())

vi.mock('../plugins/authenticate.js', () => ({ resolveActiveOrgRole }))

describe('scheduled membership scope lifetime', () => {
  afterEach(() => vi.useRealTimers())

  it.each(['resolved', 'rejected', 'timed-out'])(
    'revokes detached continuations after the invocation is %s',
    async (outcome) => {
      vi.useFakeTimers()
      const organizationId = randomUUID()
      const userId = randomUUID()
      resolveActiveOrgRole.mockResolvedValue('member')
      let resume = () => {}
      const gate = new Promise<void>((resolve) => {
        resume = resolve
      })
      let detachedCheck: ReturnType<typeof isOrgMemberForScheduledTask> | undefined
      const invocation = withScheduledTaskOrganization(organizationId, () =>
        raceWithTimeout(async () => {
          detachedCheck = gate.then(() => isOrgMemberForScheduledTask({ organizationId, userId }))
          if (outcome === 'rejected') throw new Error('task failed')
          if (outcome === 'timed-out') await gate
        }, 10)
      )
      if (outcome === 'timed-out') await vi.advanceTimersByTimeAsync(10)
      await invocation
      resume()

      await expect(detachedCheck).resolves.toEqual({
        status: 'unavailable',
        reason: 'membership_scope_unavailable',
      })
      expect(resolveActiveOrgRole).not.toHaveBeenCalled()
    }
  )
})
