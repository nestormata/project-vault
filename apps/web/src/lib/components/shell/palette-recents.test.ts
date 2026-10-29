import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_RECENTS,
  addRecent,
  checkRecent,
  clearRecents,
  readRecents,
  removeRecent,
  type RecentItem,
} from './palette-recents.js'

const project = (id: string): RecentItem => ({ type: 'project', id, name: `P${id}` })

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status })
}

describe('palette recents store', () => {
  beforeEach(() => clearRecents())

  it('keeps the newest first, de-duplicated, capped', () => {
    for (let i = 0; i < MAX_RECENTS + 2; i += 1) addRecent('u1', project(String(i)))
    addRecent('u1', project('3'))
    const ids = readRecents('u1').map((r) => r.id)
    expect(ids).toHaveLength(MAX_RECENTS)
    expect(ids[0]).toBe('3')
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('another user never sees the previous user recents', () => {
    addRecent('u1', project('a'))
    expect(readRecents('u2')).toEqual([])
    expect(readRecents('u1')).toEqual([])
  })

  it('removes one item', () => {
    addRecent('u1', project('a'))
    addRecent('u1', project('b'))
    removeRecent('u1', project('a'))
    expect(readRecents('u1').map((r) => r.id)).toEqual(['b'])
  })
})

describe('checkRecent (server re-check)', () => {
  it('ok for a readable project, carrying the caller role', async () => {
    const fetchFn = vi.fn(async () =>
      json(200, { data: { id: 'p', name: 'P', role: 'member', archivedAt: null } })
    )
    await expect(checkRecent(fetchFn as unknown as typeof fetch, project('p'))).resolves.toEqual({
      status: 'ok',
      projectRole: 'member',
      isArchived: false,
    })
  })

  it('gone on 403 and 404, unknown on a server or network error', async () => {
    const credential: RecentItem = {
      type: 'credential',
      id: 'c',
      projectId: 'p',
      name: 'C',
      projectName: 'P',
    }
    for (const status of [403, 404]) {
      const fetchFn = vi.fn(async () => json(status, { code: 'x', message: 'no' }))
      await expect(checkRecent(fetchFn as unknown as typeof fetch, credential)).resolves.toEqual({
        status: 'gone',
      })
    }
    const boom = vi.fn(async () => json(500, { code: 'x', message: 'boom' }))
    await expect(checkRecent(boom as unknown as typeof fetch, credential)).resolves.toEqual({
      status: 'unknown',
    })
    const offline = vi.fn(async () => {
      throw new TypeError('network')
    })
    await expect(checkRecent(offline as unknown as typeof fetch, credential)).resolves.toEqual({
      status: 'unknown',
    })
  })
})
