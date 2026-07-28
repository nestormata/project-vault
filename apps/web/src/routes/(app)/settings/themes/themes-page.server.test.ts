import { beforeEach, describe, expect, it, vi } from 'vitest'

const getThemesMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/themes.js', () => ({ getThemes: getThemesMock }))

import { load } from './+page.server.js'

function makeEvent(user: { orgRole: string } | null) {
  return { fetch: vi.fn(), locals: { user } } as unknown as Parameters<typeof load>[0]
}

beforeEach(() => {
  getThemesMock.mockReset()
})

describe('/settings/themes +page.server.ts load (Story 16.2 AC-1)', () => {
  it('redirects an anonymous request to /login (requireUser, no role gate)', async () => {
    await expect(load(makeEvent(null))).rejects.toMatchObject({ status: 303 })
  })

  it('returns the compiled themes list and the current selection for any authenticated role', async () => {
    getThemesMock.mockResolvedValue({
      themes: [
        { name: 'base', label: 'Default', css: null },
        { name: 'acme-brand', label: 'acme-brand', css: '[data-theme="acme-brand"] {}' },
      ],
      selected: 'acme-brand',
    })

    const result = await load(makeEvent({ orgRole: 'viewer' }))

    expect(result.themes).toEqual([
      { name: 'base', label: 'Default', css: null },
      { name: 'acme-brand', label: 'acme-brand', css: '[data-theme="acme-brand"] {}' },
    ])
    expect(result.selected).toBe('acme-brand')
    expect(result.errorMessage).toBeNull()
  })

  it('falls back to an empty themes list with an error message when the fetch fails', async () => {
    getThemesMock.mockRejectedValue(new Error('boom'))

    const result = await load(makeEvent({ orgRole: 'member' }))

    expect(result.themes).toEqual([])
    expect(result.selected).toBeNull()
    expect(result.errorMessage).toBe('Failed to load themes, try again.')
  })
})
