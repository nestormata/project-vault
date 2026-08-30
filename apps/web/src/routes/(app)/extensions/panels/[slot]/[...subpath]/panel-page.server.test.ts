import { describe, expect, it, vi, beforeEach } from 'vitest'
import { isRedirect } from '@sveltejs/kit'
import { BASE_EXTENSION_THEME_VARS } from '$lib/security/extension-theme-vars.js'

const getExtensionPanelMock = vi.hoisted(() => vi.fn())
const getThemesMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/extension-panel.js', () => ({
  getExtensionPanel: getExtensionPanelMock,
}))
vi.mock('$lib/api/themes.js', () => ({
  getThemes: getThemesMock,
}))

import { load } from './+page.server.js'

function makeEvent(user: unknown, slot = 'group', subpath = '') {
  return {
    params: { slot, subpath },
    fetch: vi.fn(),
    locals: { user },
  } as unknown as Parameters<typeof load>[0]
}

const baseUser = { id: 'u1', orgRole: 'member' }

describe('/(app)/extensions/panels/[slot] +page.server.ts (Story 25.1, Story 25.4 AC4)', () => {
  beforeEach(() => {
    getExtensionPanelMock.mockReset()
    getThemesMock.mockReset()
    getThemesMock.mockResolvedValue({ themes: [], selected: null, orgDefaultThemeName: null })
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

  it('happy path: renders the html and base theme vars on a successful, ok:true fetch, no theme applied', async () => {
    getExtensionPanelMock.mockResolvedValue({
      ok: true,
      html: '<p>hello</p>',
    })

    const result = await load(makeEvent(baseUser))

    expect(result).toEqual({
      slot: 'group',
      subpath: undefined,
      html: '<p>hello</p>',
      themeVars: BASE_EXTENSION_THEME_VARS,
      actionEndpoint: undefined,
    })
  })

  it('Story 25.5 AC4/Task 4: actionEndpoint is forwarded when the API response includes it', async () => {
    getExtensionPanelMock.mockResolvedValue({
      ok: true,
      html: '<p>hello</p>',
      actionEndpoint: '/api/v1/extensions/panels/group/actions',
    })

    const result = await load(makeEvent(baseUser))

    expect(result).toEqual({
      slot: 'group',
      subpath: undefined,
      html: '<p>hello</p>',
      themeVars: BASE_EXTENSION_THEME_VARS,
      actionEndpoint: '/api/v1/extensions/panels/group/actions',
    })
  })

  it('Story 25.5 AC4/Task 4: actionEndpoint is undefined when the API response omits it', async () => {
    getExtensionPanelMock.mockResolvedValue({
      ok: true,
      html: '<p>hello</p>',
    })

    const result = await load(makeEvent(baseUser))

    expect(result).toEqual({
      slot: 'group',
      subpath: undefined,
      html: '<p>hello</p>',
      themeVars: BASE_EXTENSION_THEME_VARS,
      actionEndpoint: undefined,
    })
  })

  it('AC3: degrades to html: null on an ok:false (panel_unavailable) response, still resolving theme vars', async () => {
    getExtensionPanelMock.mockResolvedValue({ ok: false, reason: 'panel_unavailable' })

    const result = await load(makeEvent(baseUser))

    expect(result).toEqual({
      slot: 'group',
      subpath: undefined,
      html: null,
      themeVars: BASE_EXTENSION_THEME_VARS,
      actionEndpoint: undefined,
    })
  })

  it('AC3/AC3b: degrades to html: null when the API fetch itself throws (e.g. a 400 for an invalid slot)', async () => {
    getExtensionPanelMock.mockRejectedValue(new Error('boom'))

    const result = await load(makeEvent(baseUser))

    expect(result).toEqual({
      slot: 'group',
      subpath: undefined,
      html: null,
      themeVars: BASE_EXTENSION_THEME_VARS,
      actionEndpoint: undefined,
    })
  })

  it('AC4: resolves --pv-ext-* theme vars from the applied custom theme when one is selected', async () => {
    getExtensionPanelMock.mockResolvedValue({
      ok: true,
      html: '<p>x</p>',
    })
    getThemesMock.mockResolvedValue({
      themes: [
        {
          name: 'midnight',
          label: 'Midnight',
          css: '[data-theme="midnight"] {\n  --color-background: #0f172a;\n  --color-foreground: #f1f5f9;\n}',
        },
      ],
      selected: 'midnight',
      orgDefaultThemeName: null,
    })

    const result = await load(makeEvent(baseUser))

    expect(result.themeVars['--pv-ext-surface']).toBe('#0f172a')
    expect(result.themeVars['--pv-ext-ink']).toBe('#f1f5f9')
  })

  it('AC4: fails open to base theme vars when the themes fetch itself throws', async () => {
    getExtensionPanelMock.mockResolvedValue({
      ok: true,
      html: '<p>x</p>',
    })
    getThemesMock.mockRejectedValue(new Error('themes API down'))

    const result = await load(makeEvent(baseUser))

    expect(result.themeVars).toEqual(BASE_EXTENSION_THEME_VARS)
  })

  describe('Story 25.8 AC1: sub-path forwarding', () => {
    it('a non-empty subpath route param is forwarded to getExtensionPanel and echoed in page data', async () => {
      getExtensionPanelMock.mockResolvedValue({
        ok: true,
        html: '<p>x</p>',
      })

      const result = await load(makeEvent(baseUser, 'group', 'groups/123/detail'))

      expect(getExtensionPanelMock).toHaveBeenCalledWith(
        expect.anything(),
        'group',
        'groups/123/detail'
      )
      expect(result.subpath).toBe('groups/123/detail')
    })

    it('an empty subpath route param (no sub-path in the URL) stays undefined, never an empty string', async () => {
      getExtensionPanelMock.mockResolvedValue({
        ok: true,
        html: '<p>x</p>',
      })

      const result = await load(makeEvent(baseUser, 'group', ''))

      expect(getExtensionPanelMock).toHaveBeenCalledWith(expect.anything(), 'group', undefined)
      expect(result.subpath).toBeUndefined()
    })
  })
})
