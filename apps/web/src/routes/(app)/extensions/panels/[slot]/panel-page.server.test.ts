import { describe, expect, it, vi, beforeEach } from 'vitest'
import { isRedirect } from '@sveltejs/kit'

const getExtensionPanelMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/extension-panel.js', () => ({
  getExtensionPanel: getExtensionPanelMock,
}))

import { load } from './+page.server.js'

function makeEvent(user: unknown, slot = 'group') {
  return {
    params: { slot },
    fetch: vi.fn(),
    locals: { user },
  } as unknown as Parameters<typeof load>[0]
}

const baseUser = { id: 'u1', orgRole: 'member' }

describe('/(app)/extensions/panels/[slot] +page.server.ts (Story 25.1)', () => {
  beforeEach(() => {
    getExtensionPanelMock.mockReset()
  })

  it('AC1: redirects to /login when there is no authenticated user (defense in depth)', async () => {
    let caught: unknown
    try {
      await load(makeEvent(null))
    } catch (error) {
      caught = error
    }

    expect(isRedirect(caught)).toBe(true)
    expect((caught as { location: string }).location).toBe('/login')
  })

  it('happy path: renders the html on a successful, ok:true fetch', async () => {
    getExtensionPanelMock.mockResolvedValue({ ok: true, html: '<p>hello</p>' })

    const result = await load(makeEvent(baseUser))

    expect(result).toEqual({ slot: 'group', html: '<p>hello</p>' })
  })

  it('AC3: degrades to html: null on an ok:false (panel_unavailable) response', async () => {
    getExtensionPanelMock.mockResolvedValue({ ok: false, reason: 'panel_unavailable' })

    const result = await load(makeEvent(baseUser))

    expect(result).toEqual({ slot: 'group', html: null })
  })

  it('AC3/AC3b: degrades to html: null when the API fetch itself throws (e.g. a 400 for an invalid slot)', async () => {
    getExtensionPanelMock.mockRejectedValue(new Error('boom'))

    const result = await load(makeEvent(baseUser))

    expect(result).toEqual({ slot: 'group', html: null })
  })
})
