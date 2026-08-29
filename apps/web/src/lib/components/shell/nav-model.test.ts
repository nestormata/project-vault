import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '$lib/paraglide/runtime.js'
import { m } from '$lib/paraglide/messages.js'
import { getPrimaryNavItems } from './nav-model.js'

afterEach(async () => {
  await setLocale('en', { reload: false })
})

describe('AC-24: nav label matches its destination page heading', () => {
  it('labels the /notifications nav item "Notifications", matching that page\'s <h1>', () => {
    const items = getPrimaryNavItems()
    const item = items.find((i) => i.href === '/notifications')

    expect(item?.label).toBe(m.nav_notifications())
    expect(item?.mobileLabel).toBe(m.nav_notifications())
  })

  it('no longer labels it "Alerts"', () => {
    const items = getPrimaryNavItems()
    expect(items.some((i) => i.label === 'Alerts')).toBe(false)
  })
})

// Story 28.4 AC2/Task 5: labels are m.nav_*() calls resolved fresh inside getPrimaryNavItems()'s
// own function body — every call reflects whatever locale is active when it's invoked, not just
// the locale active when this module first loaded.
describe('Story 28.4 AC1/AC2: nav item labels route through m.nav_*() and translate', () => {
  it('resolves every base nav item label/mobileLabel via m.nav_*() under the default (English) locale', () => {
    const items = getPrimaryNavItems()

    expect(items.map((i) => i.label)).toEqual([
      m.nav_dashboard(),
      m.nav_projects(),
      m.nav_secrets(),
      m.nav_notifications(),
      m.nav_health(),
      m.nav_settings(),
    ])
  })

  it('re-resolves labels in Spanish after a locale switch, with no stale English values', async () => {
    await setLocale('es', { reload: false })

    const items = getPrimaryNavItems({ isPlatformOperator: true, hasUiPanelExtension: true })

    expect(items.find((i) => i.href === '/dashboard')?.label).toBe('Panel')
    expect(items.find((i) => i.href === '/projects')?.label).toBe('Proyectos')
    expect(items.find((i) => i.href === '/platform')?.label).toBe('Administración de plataforma')
    expect(items.find((i) => i.href === '/platform')?.mobileLabel).toBe('Plataforma')
    expect(items.find((i) => i.href === '/extensions/panels/group')?.label).toBe('Extensión')
    expect(items.some((i) => i.label === 'Dashboard')).toBe(false)
  })
})

describe('Story 29.3 AC10: manifest-declared extensionNavItems merge', () => {
  it('does not add any items when extensionNavItems is omitted', () => {
    const items = getPrimaryNavItems()
    expect(items).toHaveLength(6)
  })

  it('does not add any items when extensionNavItems is an empty array (identical to omitted)', () => {
    const withEmpty = getPrimaryNavItems({ isPlatformOperator: false, extensionNavItems: [] })
    const omitted = getPrimaryNavItems()
    expect(withEmpty).toEqual(omitted)
  })

  it('appends a top-level manifest-declared item AFTER the existing hardcoded items, unchanged', () => {
    const items = getPrimaryNavItems({
      isPlatformOperator: false,
      extensionNavItems: [
        { id: 'settings-page', label: 'Extension Settings', href: '/ext/settings' },
      ],
    })

    expect(items.map((i) => i.href)).toEqual([
      '/dashboard',
      '/projects',
      '/credentials',
      '/notifications',
      '/health',
      '/settings',
      '/ext/settings',
    ])
    const appended = items.find((i) => i.href === '/ext/settings')
    expect(appended?.label).toBe('Extension Settings')
    expect(appended?.mobileLabel).toBe('Extension Settings')
  })

  it('nests a child item under its parent as `children`, not as a separate top-level entry', () => {
    const items = getPrimaryNavItems({
      isPlatformOperator: false,
      extensionNavItems: [
        { id: 'settings-page', label: 'Extension Settings', href: '/ext/settings' },
        {
          id: 'settings-child',
          label: 'Child Page',
          href: '/ext/settings/child',
          parentId: 'settings-page',
        },
      ],
    })

    expect(items.find((i) => i.href === '/ext/settings/child')).toBeUndefined()
    const parent = items.find((i) => i.href === '/ext/settings')
    expect(parent?.children).toEqual([
      expect.objectContaining({ label: 'Child Page', href: '/ext/settings/child' }),
    ])
  })

  it('carries the icon token through onto the top-level PrimaryNavItem', () => {
    const items = getPrimaryNavItems({
      isPlatformOperator: false,
      extensionNavItems: [
        { id: 'settings-page', label: 'Extension Settings', href: '/ext/settings', icon: 'grid' },
      ],
    })

    expect(items.find((i) => i.href === '/ext/settings')?.icon).toBe('grid')
  })

  it('composes independently of isPlatformOperator/hasUiPanelExtension — all three append points coexist', () => {
    const items = getPrimaryNavItems({
      isPlatformOperator: true,
      hasUiPanelExtension: true,
      extensionNavItems: [
        { id: 'settings-page', label: 'Extension Settings', href: '/ext/settings' },
      ],
    })

    expect(items.find((i) => i.href === '/platform')).toBeDefined()
    expect(items.find((i) => i.href === '/extensions/panels/group')).toBeDefined()
    expect(items.find((i) => i.href === '/ext/settings')).toBeDefined()
  })
})

describe('Story 25.1 AC5: generic extension UI-panel nav entry', () => {
  it('is absent by default (no options passed)', () => {
    const items = getPrimaryNavItems()
    expect(items.find((i) => i.href === '/extensions/panels/group')).toBeUndefined()
  })

  it('is absent when hasUiPanelExtension is false (no extension loaded, or loaded without uiPanel)', () => {
    const items = getPrimaryNavItems({ isPlatformOperator: false, hasUiPanelExtension: false })
    expect(items.find((i) => i.href === '/extensions/panels/group')).toBeUndefined()
  })

  it('appears, generically labeled, when hasUiPanelExtension is true', () => {
    const items = getPrimaryNavItems({ isPlatformOperator: false, hasUiPanelExtension: true })
    const item = items.find((i) => i.href === '/extensions/panels/group')
    expect(item).toBeDefined()
    expect(item?.label).toBe('Extension')
    expect(item?.mobileLabel).toBe('Extension')
  })

  it('composes independently of the platform-operator nav item', () => {
    const items = getPrimaryNavItems({ isPlatformOperator: true, hasUiPanelExtension: true })
    expect(items.find((i) => i.href === '/platform')).toBeDefined()
    expect(items.find((i) => i.href === '/extensions/panels/group')).toBeDefined()
  })
})
