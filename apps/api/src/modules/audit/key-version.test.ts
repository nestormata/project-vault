import type { Tx } from '@project-vault/db'
import { describe, expect, it, vi } from 'vitest'
import { currentAuditKeyVersion } from './key-version.js'

function txWithRows(rows: unknown[]) {
  return {
    select: vi.fn(() => ({
      from: () => ({
        limit: async () => rows,
      }),
    })),
  } as unknown as Tx
}

describe('currentAuditKeyVersion', () => {
  it('returns the audit key version from the query result', async () => {
    const tx = txWithRows([{ auditKeyVersion: 7 }])

    await expect(currentAuditKeyVersion(tx)).resolves.toBe(7)
  })

  it('falls back to 1 when no rows are returned', async () => {
    const tx = txWithRows([])

    await expect(currentAuditKeyVersion(tx)).resolves.toBe(1)
  })
})
