import { describe, expect, it, vi, beforeEach } from 'vitest'

const runAccessReportMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/audit.js', () => ({
  runAccessReport: runAccessReportMock,
}))

vi.mock('$lib/server/require-user.js', () => ({
  requireUser: vi.fn(),
}))

import { ApiClientError } from '$lib/api/client.js'
import { requireUser } from '$lib/server/require-user.js'
import { load } from './+page.server.js'

const requireUserMock = vi.mocked(requireUser)

function makeEvent(searchParams: Record<string, string> = {}) {
  const url = new URL('http://localhost/settings/audit/access-report')
  for (const [key, value] of Object.entries(searchParams)) url.searchParams.set(key, value)
  return { fetch: vi.fn(), url, locals: {} } as unknown as Parameters<typeof load>[0]
}

const SAMPLE_REPORT = {
  users: [
    {
      userId: 'u1',
      displayName: 'Dana Smith',
      orgRole: 'owner',
      status: 'active',
      projects: [
        {
          projectId: 'p1',
          projectName: 'Prod',
          role: 'owner',
          grantedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
  ],
  generatedAt: '2026-07-07T00:00:00.000Z',
  asOf: '2026-07-07T00:00:00.000Z',
  page: 1,
  limit: 20,
  total: 1,
  hasNext: false,
}

describe('/settings/audit/access-report +page.server.ts', () => {
  beforeEach(() => {
    runAccessReportMock.mockReset()
    requireUserMock.mockReset()
  })

  it('AC-B4/N1 equivalent: non-owner does not call the API', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'admin' } as ReturnType<typeof requireUser>)

    const result = await load(makeEvent())

    expect(result.allowed).toBe(false)
    expect(runAccessReportMock).not.toHaveBeenCalled()
  })

  it('AC-G1: the fast path (no asOf) calls runAccessReport with no asOf', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'owner' } as ReturnType<typeof requireUser>)
    runAccessReportMock.mockResolvedValue(SAMPLE_REPORT)

    const result = await load(makeEvent())

    expect(runAccessReportMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ page: 1, limit: 20 })
    )
    const [, calledParams] = runAccessReportMock.mock.calls[0] as [unknown, Record<string, unknown>]
    expect(calledParams.asOf).toBeUndefined()
    expect(result.allowed).toBe(true)
    if (result.allowed) expect(result.report?.users).toHaveLength(1)
  })

  it('AC-G2: a historical asOf query param is passed through', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'owner' } as ReturnType<typeof requireUser>)
    runAccessReportMock.mockResolvedValue({ ...SAMPLE_REPORT, asOf: '2026-03-01T00:00:00.000Z' })

    await load(makeEvent({ asOf: '2026-03-01T00:00:00.000Z' }))

    expect(runAccessReportMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ asOf: '2026-03-01T00:00:00.000Z' })
    )
  })

  it('AC-G2 failure: a future asOf maps to a friendly error message', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'owner' } as ReturnType<typeof requireUser>)
    runAccessReportMock.mockRejectedValue(
      new ApiClientError(
        422,
        { code: 'invalid_as_of', message: 'asOf cannot be in the future' },
        'asOf cannot be in the future'
      )
    )

    const result = await load(makeEvent({ asOf: '2099-01-01T00:00:00.000Z' }))

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.errorMessage).toMatch(/future date/i)
      expect(result.report).toBeNull()
    }
  })

  it('AC-G2 failure: an asOf predating the org maps to a friendly error message', async () => {
    requireUserMock.mockReturnValue({ orgRole: 'owner' } as ReturnType<typeof requireUser>)
    runAccessReportMock.mockRejectedValue(
      new ApiClientError(
        422,
        { code: 'invalid_as_of', message: 'asOf predates this organization' },
        'asOf predates this organization'
      )
    )

    const result = await load(makeEvent({ asOf: '2000-01-01T00:00:00.000Z' }))

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.errorMessage).toMatch(/before your organization was created/i)
    }
  })
})
