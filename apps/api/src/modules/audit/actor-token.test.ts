import { describe, expect, it, vi } from 'vitest'
import { type Tx } from '@project-vault/db'
import { firstActorTokenIdForUser } from './actor-token.js'

function makeTx(rows: unknown[]) {
  return {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => rows,
          }),
        }),
      }),
    })),
  } as unknown as Tx
}

describe('firstActorTokenIdForUser', () => {
  it('resolves to the id of the first row when one is found', async () => {
    const tx = makeTx([{ id: 'token-123' }])

    await expect(firstActorTokenIdForUser(tx, 'user-1')).resolves.toBe('token-123')
  })

  it('resolves to null when no rows are found', async () => {
    const tx = makeTx([])

    await expect(firstActorTokenIdForUser(tx, 'user-1')).resolves.toBeNull()
  })
})
