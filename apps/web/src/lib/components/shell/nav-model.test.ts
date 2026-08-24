import { describe, expect, it } from 'vitest'
import { getPrimaryNavItems } from './nav-model.js'

describe('AC-24: nav label matches its destination page heading', () => {
  it('labels the /notifications nav item "Notifications", matching that page\'s <h1>', () => {
    const items = getPrimaryNavItems()
    const item = items.find((i) => i.href === '/notifications')

    expect(item?.label).toBe('Notifications')
    expect(item?.mobileLabel).toBe('Notifications')
  })

  it('no longer labels it "Alerts"', () => {
    const items = getPrimaryNavItems()
    expect(items.some((i) => i.label === 'Alerts')).toBe(false)
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
