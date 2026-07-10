import { describe, expect, it, vi, beforeEach } from 'vitest'

const getPublicStatusPageMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/public-status-page.js', () => ({
  getPublicStatusPage: getPublicStatusPageMock,
}))

import { load } from './+page.server.js'

const token = 'status-token-1'

function makeEvent() {
  return {
    params: { token },
    fetch: vi.fn(),
  } as unknown as Parameters<typeof load>[0]
}

describe('/status/[token] +page.server.ts', () => {
  beforeEach(() => {
    getPublicStatusPageMock.mockReset()
  })

  it('returns the fetched status page on success', async () => {
    const statusPage = {
      services: [{ displayName: 'API', status: 'healthy', lastCheckedAt: null }],
    }
    getPublicStatusPageMock.mockResolvedValue(statusPage)

    const result = await load(makeEvent())

    expect(result).toEqual({ statusPage })
    expect(getPublicStatusPageMock).toHaveBeenCalledWith(expect.any(Function), token)
  })

  it('swallows any error (invalid/disabled token) and returns statusPage: null instead of throwing', async () => {
    getPublicStatusPageMock.mockRejectedValue(new Error('404'))

    const result = await load(makeEvent())

    expect(result).toEqual({ statusPage: null })
  })
})
