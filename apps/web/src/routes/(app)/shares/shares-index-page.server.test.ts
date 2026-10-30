import { beforeEach, describe, expect, it, vi } from 'vitest'

const listSharesIndexMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/credential-shares.js', () => ({ listSharesIndex: listSharesIndexMock }))

import { load } from './+page.server.js'
import { expectLoaded } from '$lib/test/page-data.js'

function makeEvent(search = '') {
  return {
    fetch: vi.fn(),
    url: new URL(`http://localhost/shares${search}`),
  } as unknown as Parameters<typeof load>[0]
}

describe('/shares +page.server.ts (Story 72.11 AC1)', () => {
  beforeEach(() => {
    listSharesIndexMock.mockReset()
    listSharesIndexMock.mockResolvedValue({ items: [], total: 0 })
  })

  it('asks for the first page with no filter by default', async () => {
    const result = expectLoaded(await load(makeEvent()))
    expect(listSharesIndexMock).toHaveBeenCalledWith(expect.anything(), { limit: 25, offset: 0 })
    expect(result).toMatchObject({
      items: [],
      total: 0,
      page: 1,
      pageSize: 25,
      displayStatus: null,
    })
  })

  it('passes a known displayStatus and turns page into an offset', async () => {
    const result = expectLoaded(await load(makeEvent('?displayStatus=locked&page=3')))
    expect(listSharesIndexMock).toHaveBeenCalledWith(expect.anything(), {
      displayStatus: 'locked',
      limit: 25,
      offset: 50,
    })
    expect(result.displayStatus).toBe('locked')
    expect(result.page).toBe(3)
  })

  it.each(['?displayStatus=bogus', '?displayStatus=viewed', '?displayStatus='])(
    'reads an unknown filter %s as All',
    async (search) => {
      const result = expectLoaded(await load(makeEvent(search)))
      expect(result.displayStatus).toBeNull()
      expect(listSharesIndexMock).toHaveBeenCalledWith(expect.anything(), {
        limit: 25,
        offset: 0,
      })
    }
  )

  it.each(['?page=0', '?page=-2', '?page=abc', '?page=1.5'])(
    'reads a bad page %s as page 1',
    async (search) => {
      const result = expectLoaded(await load(makeEvent(search)))
      expect(result.page).toBe(1)
    }
  )
})
