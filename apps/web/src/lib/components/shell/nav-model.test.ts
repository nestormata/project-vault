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
