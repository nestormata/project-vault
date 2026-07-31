import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'

const setLocaleMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('$lib/paraglide/runtime.js', () => ({ setLocale: setLocaleMock }))
vi.mock('$lib/paraglide/messages.js', () => ({
  m: {
    settings_nav_language_title: () => 'Language',
    settings_language_locale_en: () => 'English',
    settings_language_locale_es: () => 'Español',
  },
}))

import PreAuthLanguageSwitcher from './PreAuthLanguageSwitcher.svelte'

describe('PreAuthLanguageSwitcher', () => {
  afterEach(() => {
    cleanup()
    setLocaleMock.mockClear()
  })

  it('uses the settings control pattern with a visible text label for both locales', () => {
    render(PreAuthLanguageSwitcher)

    expect(screen.getByText('Language')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'English' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Español' })).toBeTruthy()
  })

  it('changes locale without reloading and keeps the switcher usable on narrow layouts', async () => {
    render(PreAuthLanguageSwitcher)

    await fireEvent.click(screen.getByRole('button', { name: 'Español' }))

    expect(setLocaleMock).toHaveBeenCalledWith('es', { reload: false })
    expect(screen.getByRole('group').className).toContain('flex-wrap')
  })

  it('trusts the most recently requested locale when setLocale calls resolve out of order', async () => {
    let resolveFirst: (() => void) | undefined
    setLocaleMock
      .mockImplementationOnce(() => new Promise<void>((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce(undefined)

    render(PreAuthLanguageSwitcher)
    await fireEvent.click(screen.getByRole('button', { name: 'English' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Español' }))
    resolveFirst?.()

    expect(setLocaleMock).toHaveBeenLastCalledWith('es', { reload: false })
  })
})
