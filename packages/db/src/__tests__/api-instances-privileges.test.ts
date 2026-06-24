import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { getDb } from '../index.js'

describe('api_instances privilege model (T1 — DoS mitigation)', () => {
  it('blocks vault_app from deleting api_instances rows', async () => {
    const [row] = await getDb().execute(sql`INSERT INTO api_instances DEFAULT VALUES RETURNING id`)
    const id = (row as { id: string }).id

    await expect(
      getDb().execute(sql`DELETE FROM api_instances WHERE id = ${id}`)
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/permission denied/) } })
  })
})
