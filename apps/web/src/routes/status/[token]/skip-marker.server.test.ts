import { beforeEach, describe, expect, it, vi } from 'vitest'

const getPublicStatusPageMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/public-status-page.js', () => ({
  getPublicStatusPage: getPublicStatusPageMock,
}))
// The raw own load: `withInjectedLoad` (which consumes and strips the marker) is replaced by identity.
vi.mock('$lib/server/composition/inject-behavior.js', () => ({
  withInjectedLoad: (own: unknown) => own,
  injectActions: () => undefined,
}))

import { load } from './+page.server.js'

const event = { params: { token: 'fixed-fake-token' }, fetch: vi.fn() } as unknown as Parameters<
  typeof load
>[0]

// Story 69.3 AC-5.4: an invalid, disabled or sealed token answers `statusPage: null` and marks it
// `skipInjectedLoads: true`, so no contribution load runs for it (no token-validity oracle for a pack).
describe('/status/[token] +page.server.ts skip marker (Story 69.3)', () => {
  beforeEach(() => getPublicStatusPageMock.mockReset())

  it('marks the null answer, whatever the failure was', async () => {
    for (const failure of [new Error('404'), new Error('503'), 'weird']) {
      getPublicStatusPageMock.mockRejectedValueOnce(failure)
      expect(await load(event)).toEqual({ statusPage: null, skipInjectedLoads: true })
    }
  })

  it('does not mark a valid status page', async () => {
    const statusPage = { services: [] }
    getPublicStatusPageMock.mockResolvedValue(statusPage)
    const result = await load(event)
    expect(result).toEqual({ statusPage })
    expect(result).not.toHaveProperty('skipInjectedLoads')
  })
})
