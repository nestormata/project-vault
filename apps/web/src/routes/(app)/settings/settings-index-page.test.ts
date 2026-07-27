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
})
