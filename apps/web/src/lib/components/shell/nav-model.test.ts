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
