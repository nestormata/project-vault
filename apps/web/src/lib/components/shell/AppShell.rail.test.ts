// Story 72.7 (P3b): the rail variant of AppShell. The default (`header`) shell is pinned byte for
// byte by AppShell.characterization.test.ts; this file covers what `variant="rail"` changes.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/svelte'
import { createRawSnippet } from 'svelte'

vi.mock('$app/navigation', () => ({ goto: vi.fn(async () => {}) }))
vi.mock('$lib/api/auth.js', () => ({ logout: vi.fn(async () => undefined) }))
const mockedPage = vi.hoisted(() => ({ url: new URL('http://localhost/dashboard') }))
vi.mock('$app/state', () => ({ page: mockedPage }))

import { testAuthUser } from '$lib/test/page-data.js'
import AppShell from './AppShell.svelte'

const children = createRawSnippet(() => ({ render: () => '<p>page body</p>' }))

function shell(props: Record<string, unknown> = {}) {
  return render(AppShell, {
    props: { user: testAuthUser({ orgRole: 'admin' }), children, variant: 'rail', ...props },
  })
}

afterEach(() => {
  cleanup()
  mockedPage.url = new URL('http://localhost/dashboard')
})

describe('AppShell variant="rail"', () => {
  it('renders the primary nav as a rail beside the page, not in the header', () => {
    shell()
    const rail = screen.getByTestId('nav-rail')
    expect(rail.className).toContain('hidden')
    expect(rail.className).toContain('md:block')
    const nav = within(rail).getByTestId('primary-nav')
    expect(nav.getAttribute('data-nav-variant')).toBe('rail')
    expect(nav.className).toBe('flex flex-col gap-1')
    expect(within(rail).getByRole('link', { name: /Dashboard/ })).toBeTruthy()
    // The header keeps brand, search field, notifications and account only.
    const header = document.querySelector('header') as HTMLElement
    expect(within(header).queryByTestId('primary-nav')).toBeNull()
    expect(within(header).getByTestId('header-search-field')).toBeTruthy()
    expect(within(header).getByTestId('header-search-icon').className).toContain('md:hidden')
    expect(within(header).getByTestId('account-menu')).toBeTruthy()
  })

  it('renders the bottom bar from the same data, and the page body in main', () => {
    shell()
    expect(screen.getByTestId('bottom-bar')).toBeTruthy()
    expect(document.getElementById('main-content')?.textContent).toContain('page body')
    expect(document.getElementById('main-content')?.className).toContain('flex-1')
    // Room under the page for the fixed bar, below md only.
    expect(
      document.querySelector('[class*="safe-area-inset-bottom"][class*="md:pb-0"]')
    ).not.toBeNull()
  })

  it('has no bottom bar and no bar spacing on a task page', () => {
    mockedPage.url = new URL('http://localhost/projects/new')
    shell()
    expect(screen.queryByTestId('bottom-bar')).toBeNull()
    expect(screen.getByTestId('nav-rail')).toBeTruthy()
    expect(document.querySelector('[class*="safe-area-inset-bottom"][class*="md:pb-0"]')).toBeNull()
  })

  it('has neither rail nor bottom bar while the nav is hidden (onboarding)', () => {
    shell({ hidePrimaryNav: true })
    expect(screen.queryByTestId('nav-rail')).toBeNull()
    expect(screen.queryByTestId('bottom-bar')).toBeNull()
    expect(screen.queryByTestId('header-search-icon')).toBeNull()
    expect(screen.getByTestId('account-menu')).toBeTruthy()
  })

  it('the default variant has no rail, no bottom bar and keeps the nav in the header', () => {
    shell({ variant: 'header' })
    expect(screen.queryByTestId('nav-rail')).toBeNull()
    expect(screen.queryByTestId('bottom-bar')).toBeNull()
    expect(screen.queryByTestId('header-search-icon')).toBeNull()
    expect(
      within(document.querySelector('header') as HTMLElement).getByTestId('primary-nav')
    ).toBeTruthy()
  })

  it('a disclosure in the rail is an inline panel, not a popover', () => {
    shell({
      extensionNavItems: [
        { id: 'p', label: 'Tools', href: '/ext/tools' },
        { id: 'c', label: 'Sub', href: '/ext/tools/sub', parentId: 'p' },
      ],
    })
    const panel = within(screen.getByTestId('nav-rail')).getByText('Sub').parentElement
    expect(panel?.className).toBe('flex flex-col gap-1 py-1 pl-3')
  })
})
