// Story 72.6 (P3a): the skip link is the first tab stop of the app shell, also ahead of the
// orphaned-theme notice, and it targets the shell's main region.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import { createRawSnippet } from 'svelte'
import { setLocale } from '$lib/paraglide/runtime.js'

vi.mock('$app/navigation', () => ({ goto: vi.fn(async () => {}) }))
vi.mock('$lib/api/auth.js', () => ({ logout: vi.fn(async () => undefined) }))
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/dashboard') } }))

import { testAuthUser } from '$lib/test/page-data.js'
import AppLayoutShell from './AppLayoutShell.svelte'

afterEach(async () => {
  cleanup()
  await setLocale('en', { reload: false })
})

const body = createRawSnippet(() => ({ render: () => '<p>page body</p>' }))

function mount(orphanedNoticeVisible: boolean) {
  return render(AppLayoutShell, {
    props: {
      appliedTheme: null,
      orphanedNoticeVisible,
      dismissOrphanedNotice: () => {},
      user: testAuthUser({ orgRole: 'owner', orgName: 'Acme' }),
      onboardingDone: true,
      unreadCount: 0,
      hasUiPanelExtension: false,
      extensionNavItems: [],
      injected: undefined,
      openSearch: () => {},
      projects: [],
      importRouteLive: false,
      completeOnboarding: async () => {},
      body,
    },
  })
}

function tabStops(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('a[href], button, summary, input')].filter(
    (el) => el.getAttribute('tabindex') !== '-1'
  )
}

describe('AppLayoutShell skip link (Story 72.6)', () => {
  it('renders the skip link first, pointing at the main region that exists', () => {
    const { container } = mount(false)
    const first = tabStops(container)[0]
    expect(first?.getAttribute('data-testid')).toBe('skip-link')
    expect(first?.textContent).toBe('Skip to main content')
    const href = first?.getAttribute('href') ?? ''
    expect(href).toBe('#main-content')
    expect(container.querySelector(href)).toBe(screen.getByRole('main'))
  })

  it('stays ahead of the orphaned-theme notice button', () => {
    const { container } = mount(true)
    const stops = tabStops(container)
    expect(stops[0]?.getAttribute('data-testid')).toBe('skip-link')
    expect(stops[1]?.textContent?.trim()).toBe('Dismiss')
  })

  it('the skip link label follows the locale', async () => {
    await setLocale('es', { reload: false })
    mount(false)
    expect(screen.getByTestId('skip-link').textContent).toBe('Saltar al contenido principal')
  })
})
