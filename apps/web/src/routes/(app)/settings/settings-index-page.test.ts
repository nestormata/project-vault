import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import SettingsIndexPage from './+page.svelte'

afterEach(() => cleanup())

describe('/settings +page.svelte', () => {
  it('lists a Language entry alongside Notifications/Users/Security/Audit (Story 15.1 Task 6.3)', () => {
    render(SettingsIndexPage)

    const link = screen.getByText('Language').closest('a')
    expect(link).toBeTruthy()
    expect(link?.getAttribute('href')).toBe('/settings/language')
  })

  it('lists an Extensions entry after Audit & Compliance (Story 14.5 Task 5)', () => {
    render(SettingsIndexPage)

    const link = screen.getByText('Extensions').closest('a')
    expect(link).toBeTruthy()
    expect(link?.getAttribute('href')).toBe('/settings/extensions')
  })

  it('lists an SSO Domains entry after Extensions (Story 14.6 Task 7)', () => {
    render(SettingsIndexPage)

    const link = screen.getByText('SSO Domains').closest('a')
    expect(link).toBeTruthy()
    expect(link?.getAttribute('href')).toBe('/settings/sso-domains')
  })
})
