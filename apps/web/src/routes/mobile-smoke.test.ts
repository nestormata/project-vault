import { describe, expect, it } from 'vitest'
import { getPrimaryNavItems, isActiveNavItem } from '$lib/components/shell/nav-model.js'

describe('mobile shell smoke', () => {
  it('app shell exposes mobile-friendly primary navigation controls', () => {
    const items = getPrimaryNavItems()

    expect(items.map((item) => item.label)).toEqual([
      'Dashboard',
      'Projects',
      'Credentials',
      'Notifications',
      'Health',
      'Settings',
    ])
    expect(items.every((item) => item.href.startsWith('/'))).toBe(true)
    expect(items.every((item) => item.mobileLabel.length > 0)).toBe(true)
  })

  it('active nav matching supports primary routes without fixed desktop-only assumptions', () => {
    expect(isActiveNavItem('/dashboard', '/dashboard')).toBe(true)
    expect(isActiveNavItem('/projects', '/projects/preview')).toBe(true)
    expect(isActiveNavItem('/projects', '/projects/new')).toBe(true)
    expect(isActiveNavItem('/credentials', '/dashboard')).toBe(false)
  })
})
