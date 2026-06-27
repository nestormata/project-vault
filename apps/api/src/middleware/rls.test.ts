import { describe, expect, it, vi } from 'vitest'
import { RLS_ORG_SETTING, setRlsOrgContext, runOrgScopedJob } from './rls.js'

const TEST_ORG_ID = ['00000000', '0000', '4000', '8000', '000000000001'].join('-')

describe('RLS middleware helpers', () => {
  it('sets app.current_org_id with a transaction-scoped set_config call', async () => {
    const tx = { execute: vi.fn() }

    await setRlsOrgContext(tx, TEST_ORG_ID)

    const query = tx.execute.mock.calls[0]?.[0] as { queryChunks?: unknown[] }
    expect(query).toEqual(expect.objectContaining({ queryChunks: expect.any(Array) }))
    expect(JSON.stringify(query.queryChunks)).toContain(RLS_ORG_SETTING)
    expect(JSON.stringify(query.queryChunks)).toContain(TEST_ORG_ID)
    expect(JSON.stringify(query.queryChunks)).toContain('true')
  })

  it('rejects invalid background job org IDs before opening a transaction', async () => {
    const db = { transaction: vi.fn() }

    await expect(
      runOrgScopedJob('not-a-uuid', 'test-job', async () => undefined, { db })
    ).rejects.toThrow('runOrgScopedJob: invalid orgId')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('passes the same RLS transaction to background job handlers', async () => {
    const tx = { execute: vi.fn() }
    const db = { transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)) }
    const handler = vi.fn(async () => 'done')

    const result = await runOrgScopedJob(TEST_ORG_ID, 'test-job', handler, { db })

    expect(result).toBe('done')
    expect(db.transaction).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith({
      tx,
      orgId: TEST_ORG_ID,
      jobName: 'test-job',
    })
  })
})
