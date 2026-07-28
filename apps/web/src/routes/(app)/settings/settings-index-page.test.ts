import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import SettingsIndexPage from './+page.svelte'

afterEach(() => cleanup())

describe('/settings +page.svelte', () => {
  it.each([
    [
      'Language',
      '/settings/language',
      'alongside Notifications/Users/Security/Audit (Story 15.1 Task 6.3)',
    ],
    ['Extensions', '/settings/extensions', 'after Audit & Compliance (Story 14.5 Task 5)'],
    ['SSO Domains', '/settings/sso-domains', 'after Extensions (Story 14.6 Task 7)'],
  ])('lists a %s entry %s', (label, href) => {
    render(SettingsIndexPage)

    const link = screen.getByText(label).closest('a')
    expect(link).toBeTruthy()
    expect(link?.getAttribute('href')).toBe(href)
  })
})
