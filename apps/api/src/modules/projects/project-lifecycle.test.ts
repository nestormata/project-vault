import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tx } from '@project-vault/db'

const findBlockingRotationIds = vi.fn()
const activeMachineUserKeysQuery = vi.fn()
vi.mock('./archive-guards.js', () => ({
  findBlockingRotationIds: (...args: unknown[]) => findBlockingRotationIds(...args),
}))
vi.mock('../machine-users/archival-check.js', () => ({
  activeMachineUserKeysQuery: (...args: unknown[]) => activeMachineUserKeysQuery(...args),
}))

const { findDeleteBlockers, purgeAfterFor, PROJECT_DELETE_GRACE_DAYS } =
  await import('./project-lifecycle.js')

const TX = {} as Tx
const PROJECT_ID = crypto.randomUUID()

beforeEach(() => {
  findBlockingRotationIds.mockReset().mockResolvedValue([])
  activeMachineUserKeysQuery.mockReset().mockResolvedValue([])
})

describe('findDeleteBlockers (72-9)', () => {
  it('is not blocked when there is no rotation and no active key', async () => {
    expect(await findDeleteBlockers(TX, PROJECT_ID)).toEqual({ blocked: false })
  })

  it('blocks on an active rotation with the archive error shape, before looking at keys', async () => {
    findBlockingRotationIds.mockResolvedValue(['r1', 'r2'])
    expect(await findDeleteBlockers(TX, PROJECT_ID)).toEqual({
      blocked: true,
      body: { error: 'active_rotations', rotationIds: ['r1', 'r2'] },
    })
    expect(activeMachineUserKeysQuery).not.toHaveBeenCalled()
  })

  it('blocks on an active machine-user key', async () => {
    activeMachineUserKeysQuery.mockResolvedValue([{ machineUserId: 'm1' }])
    expect(await findDeleteBlockers(TX, PROJECT_ID)).toEqual({
      blocked: true,
      body: { error: 'active_machine_user_keys', machineUserIds: ['m1'] },
    })
  })
})

describe('purgeAfterFor', () => {
  it('adds exactly the grace period', () => {
    const deletedAt = new Date('2026-01-01T00:00:00.000Z')
    expect(purgeAfterFor(deletedAt).getTime() - deletedAt.getTime()).toBe(
      PROJECT_DELETE_GRACE_DAYS * 86_400_000
    )
  })
})
