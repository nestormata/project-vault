import { describe, it, expect, vi, beforeEach } from 'vitest'

// Unit-level coverage for withTestOrg()'s cleanup error-classification branches:
// a genuinely unexpected failure (not append-only / not a FK violation) must propagate
// rather than being silently swallowed. These paths can't be triggered against a real
// database without artificially corrupting it, so the index.js dependency is mocked.
const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  withOrg: vi.fn(),
}))

vi.mock('./index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./index.js')>()
  return {
    ...actual,
    getDb: () => ({ execute: mocks.execute }),
    withOrg: mocks.withOrg,
  }
})

const UNEXPECTED_MESSAGE = 'connection terminated unexpectedly'

function makeQueryError(causeMessage: string, causeCode?: string): Error {
  const cause = Object.assign(new Error(causeMessage), causeCode ? { code: causeCode } : {})
  return Object.assign(new Error('Failed query: ...'), { cause })
}

// Queues the withOrg() call that runs withTestOrg()'s own fn body (always the first call).
function mockTestBody(): void {
  mocks.withOrg.mockImplementationOnce(async (_orgId: string, fn: (ctx: unknown) => unknown) =>
    fn({ orgId: 'x', tx: {} })
  )
}

describe('withTestOrg cleanup — unexpected error propagation', () => {
  beforeEach(() => {
    mocks.execute.mockReset()
    mocks.withOrg.mockReset()
  })

  it('rethrows an unexpected error from the audit_log_entries delete', async () => {
    const { withTestOrg } = await import('./test-helpers.js')

    mocks.execute.mockResolvedValueOnce(undefined) // INSERT organizations
    mockTestBody()
    mocks.withOrg.mockRejectedValueOnce(makeQueryError(UNEXPECTED_MESSAGE)) // audit_log delete

    await expect(withTestOrg(async () => 'ok')).rejects.toMatchObject({
      cause: { message: UNEXPECTED_MESSAGE },
    })

    // The unexpected rethrow aborts the rest of cleanup — security_alerts delete never runs.
    expect(mocks.withOrg).toHaveBeenCalledTimes(2)
  })

  it('rethrows an unexpected error from the organizations delete', async () => {
    const { withTestOrg } = await import('./test-helpers.js')

    mocks.execute
      .mockResolvedValueOnce(undefined) // INSERT organizations
      .mockRejectedValueOnce(makeQueryError(UNEXPECTED_MESSAGE, '08006')) // DELETE organizations (not 23503)
    mockTestBody()
    mocks.withOrg
      .mockResolvedValueOnce(undefined) // audit_log delete succeeds
      .mockResolvedValueOnce(undefined) // security_alerts delete succeeds

    await expect(withTestOrg(async () => 'ok')).rejects.toMatchObject({
      cause: { message: UNEXPECTED_MESSAGE },
    })
  })

  it('swallows a non-Error rejection from the audit_log_entries delete as not append-only', async () => {
    const { withTestOrg } = await import('./test-helpers.js')

    mocks.execute.mockResolvedValueOnce(undefined) // INSERT organizations
    mockTestBody()
    mocks.withOrg.mockRejectedValueOnce('not an Error instance') // audit_log delete throws a non-Error

    await expect(withTestOrg(async () => 'ok')).rejects.toBe('not an Error instance')
  })
})
