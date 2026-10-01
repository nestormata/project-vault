import { describe, expect, it } from 'vitest'
import { appLayoutData, expectAction, expectLoaded, testAuthUser } from './page-data.js'

describe('page-data test fixtures (Story 68.1 Q2)', () => {
  it('testAuthUser applies overrides over a complete AuthUser', () => {
    expect(testAuthUser({ orgRole: 'viewer' })).toMatchObject({
      orgRole: 'viewer',
      userId: 'user-1',
    })
  })

  it('appLayoutData supplies every (app) layout field and applies overrides', () => {
    const data = appLayoutData({ unreadCount: 3 })
    expect(data.unreadCount).toBe(3)
    expect(data.user.orgId).toBe('org-1')
    expect(data.extensionNavItems).toEqual([])
  })

  it('expectLoaded returns load data and rejects a void result', () => {
    expect(expectLoaded({ allowed: true })).toEqual({ allowed: true })
    expect(() => expectLoaded(undefined)).toThrow('load() returned no data')
  })

  it('expectAction returns a defined action and rejects a missing one', () => {
    const save = () => 'saved'
    const actions: Record<string, (() => string) | undefined> = { save }
    expect(expectAction(actions, 'save')()).toBe('saved')
    expect(() => expectAction(actions, 'missing')).toThrow('no "missing" action')
  })
})
