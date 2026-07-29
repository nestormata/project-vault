import { beforeEach, describe, expect, it, vi } from 'vitest'

const getThemesMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/themes.js', () => ({ getThemes: getThemesMock }))

import { load } from './+page.server.js'

function makeEvent(user: { orgRole: string } | null) {
  const withOrgId = user ? { ...user, orgId: 'org-1' } : null
  return { fetch: vi.fn(), locals: { user: withOrgId } } as unknown as Parameters<typeof load>[0]
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
      orgDefaultThemeName: null,
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

// Story 16.4 Task 5.2 — orgDefaultThemeName is already available from getThemes()'s response
// (Task 3), so this page's load pre-selects it directly, no new fetch.
describe('/settings/themes +page.server.ts load — orgDefaultThemeName (Story 16.4 Task 5.2)', () => {
  it('passes through the current org default theme name for pre-selection', async () => {
    getThemesMock.mockResolvedValue({
      themes: [{ name: 'base', label: 'Default', css: null }],
      selected: null,
      orgDefaultThemeName: 'acme-brand',
    })

    const result = await load(makeEvent({ orgRole: 'admin' }))

    expect(result.orgDefaultThemeName).toBe('acme-brand')
  })

  it('falls back to null orgDefaultThemeName when the fetch fails', async () => {
    getThemesMock.mockRejectedValue(new Error('boom'))

    const result = await load(makeEvent({ orgRole: 'admin' }))

    expect(result.orgDefaultThemeName).toBeNull()
  })
})

// Story 16.3 AC-1 — the reload section needs its own independent role gate: this page has no
// overall role gate (every authenticated member can view/select), but `canReload` mirrors
// `sso-domains`'s `canManageSsoDomains(orgRole)` shape (admin/owner, not an exclusion list).
describe('/settings/themes +page.server.ts load — canReload gate (Story 16.3 AC-1)', () => {
  beforeEach(() => {
    getThemesMock.mockResolvedValue({ themes: [], selected: null, orgDefaultThemeName: null })
  })

  it('canReload is true for orgRole "admin"', async () => {
    const result = await load(makeEvent({ orgRole: 'admin' }))
    expect(result.orgRole).toBe('admin')
    expect(result.canReload).toBe(true)
  })

  it('canReload is true for orgRole "owner"', async () => {
    const result = await load(makeEvent({ orgRole: 'owner' }))
    expect(result.orgRole).toBe('owner')
    expect(result.canReload).toBe(true)
  })

  it('canReload is false for orgRole "member"', async () => {
    const result = await load(makeEvent({ orgRole: 'member' }))
    expect(result.orgRole).toBe('member')
    expect(result.canReload).toBe(false)
  })

  it('canReload is false for orgRole "viewer"', async () => {
    const result = await load(makeEvent({ orgRole: 'viewer' }))
    expect(result.orgRole).toBe('viewer')
    expect(result.canReload).toBe(false)
  })
})
