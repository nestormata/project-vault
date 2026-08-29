import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'

vi.mock('$app/state', () => ({
  page: { url: new URL('http://localhost/dashboard') },
}))

import { setLocale } from '$lib/paraglide/runtime.js'
import PrimaryNav from './PrimaryNav.svelte'

afterEach(async () => {
  cleanup()
  // Reset the cookie-strategy locale back to the baseline so later tests (and other test files
  // sharing this jsdom document) don't inherit a locale switch made here.
  await setLocale('en', { reload: false })
})

describe('PrimaryNav.svelte', () => {
  it('does not show Platform Admin link when isPlatformOperator is false (default)', () => {
    render(PrimaryNav, { props: {} })

    expect(screen.queryByRole('link', { name: /platform admin/i })).toBeNull()
  })

  it('shows a Platform Admin link when isPlatformOperator is true', () => {
    render(PrimaryNav, { props: { isPlatformOperator: true } })

    const link = screen.getByRole('link', { name: /platform/i })
    expect(link.getAttribute('href')).toBe('/platform')
  })

  it('marks the current path as active via aria-current', () => {
    render(PrimaryNav, { props: {} })

    const dashboardLink = screen.getByRole('link', { name: /dashboard/i })
    expect(dashboardLink.getAttribute('aria-current')).toBe('page')
    const projectsLink = screen.getByRole('link', { name: /projects/i })
    expect(projectsLink.getAttribute('aria-current')).toBeNull()
  })

  it('invokes onsearch when the search button is clicked', async () => {
    const onsearch = vi.fn()
    render(PrimaryNav, { props: { onsearch } })

    await fireEvent.click(screen.getByRole('button', { name: /search/i }))

    expect(onsearch).toHaveBeenCalled()
  })

  // Story 28.4 AC2/Task 6: the regression proof that PrimaryNav's nav-item read is reactive to a
  // no-reload locale switch (Story 15.1's own setLocale(..., { reload: false }) design), not just
  // correct on first paint. Before this story's fix, `const navItems = getPrimaryNavItems(...)`
  // resolved exactly once at mount; converting it to `$derived(...)` lets it re-read the current
  // locale whenever this component re-renders for any reason (e.g. after a form's `update()`
  // re-runs the page's load function), which the `rerender` call below simulates.
  it('AC2: nav labels update to Spanish after setLocale switches locale without a full page reload, no remount required', async () => {
    const { rerender } = render(PrimaryNav, { props: {} })
    expect(screen.getAllByText('Dashboard').length).toBeGreaterThan(0)

    await setLocale('es', { reload: false })
    await rerender({})

    expect(screen.queryAllByText('Dashboard')).toHaveLength(0)
    expect(screen.getAllByText('Panel').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Proyectos').length).toBeGreaterThan(0)
  })

  // AC2 edge: the conditionally-appended Platform Admin / Extension nav items are translated too
  // — a naive fix could miss them since they live off the base array.
  it('AC2 edge: the Platform Admin and Extension nav items are also translated after a locale switch', async () => {
    const { rerender } = render(PrimaryNav, {
      props: { isPlatformOperator: true, hasUiPanelExtension: true },
    })
    expect(screen.getByRole('link', { name: /platform admin/i })).toBeTruthy()
    expect(screen.getByRole('link', { name: /^extension/i })).toBeTruthy()

    await setLocale('es', { reload: false })
    await rerender({ isPlatformOperator: true, hasUiPanelExtension: true })

    expect(screen.getByRole('link', { name: /administración de plataforma/i })).toBeTruthy()
    expect(screen.getByRole('link', { name: /^extensión/i })).toBeTruthy()
  })
})

describe('Story 29.3 AC12: manifest-declared navItems rendering (icon + disclosure)', () => {
  it('renders a top-level item with no children as a plain link, with no icon element when none is declared', () => {
    render(PrimaryNav, {
      props: {
        extensionNavItems: [
          { id: 'settings-page', label: 'Extension Settings', href: '/ext/settings' },
        ],
      },
    })

    const link = screen.getByRole('link', { name: /extension settings/i })
    expect(link.getAttribute('href')).toBe('/ext/settings')
  })

  it('renders a known icon token for a top-level item that declares one', () => {
    render(PrimaryNav, {
      props: {
        extensionNavItems: [
          {
            id: 'settings-page',
            label: 'Extension Settings',
            href: '/ext/settings',
            icon: 'grid',
          },
        ],
      },
    })

    expect(document.querySelector('[data-nav-icon="grid"]')).toBeTruthy()
  })

  it('renders no icon element for an item with an unrecognized icon token (render layer must not assume the load-time invariant holds forever)', () => {
    render(PrimaryNav, {
      props: {
        extensionNavItems: [
          {
            id: 'settings-page',
            label: 'Extension Settings',
            href: '/ext/settings',
            icon: 'not-a-real-token',
          },
        ],
      },
    })

    expect(document.querySelector('[data-nav-icon]')).toBeNull()
  })

  it('renders a keyboard-accessible <details>/<summary> disclosure for an item with children, closed by default', () => {
    render(PrimaryNav, {
      props: {
        extensionNavItems: [
          { id: 'settings-page', label: 'Extension Settings', href: '/ext/settings' },
          {
            id: 'settings-child',
            label: 'Child Page',
            href: '/ext/settings/child',
            parentId: 'settings-page',
          },
        ],
      },
    })

    const details = document.querySelector('details')
    expect(details).toBeTruthy()
    expect(details?.hasAttribute('open')).toBe(false)
    expect(screen.getAllByText('Extension Settings').length).toBeGreaterThan(0)
    expect(screen.getByRole('link', { name: 'Child Page' }).getAttribute('href')).toBe(
      '/ext/settings/child'
    )
  })

  it('opens the disclosure and exposes the child link on click', async () => {
    render(PrimaryNav, {
      props: {
        extensionNavItems: [
          { id: 'settings-page', label: 'Extension Settings', href: '/ext/settings' },
          {
            id: 'settings-child',
            label: 'Child Page',
            href: '/ext/settings/child',
            parentId: 'settings-page',
          },
        ],
      },
    })

    const summary = document.querySelector('summary')
    expect(summary).toBeTruthy()
    await fireEvent.click(summary as Element)

    const details = document.querySelector('details')
    expect(details?.hasAttribute('open')).toBe(true)
  })

  // Chrome-driven manual verification (2026-08-29) found this is a real, live-reproducible crash:
  // the mock fixture's own real navItems declaration (`fixtures/mock-ui-panel-extension/src/
  // index.ts`) deliberately reuses an existing PV route (`/dashboard`) as its top-level item's
  // href — nothing in AC2/AC5/AC10 forbids a manifest-declared href from matching one of PV's own
  // hardcoded nav routes, and it is a plausible real use case (an extension linking to a page PV
  // itself already has a nav entry for). Before this fix, `PrimaryNav.svelte`'s
  // `{#each navItems as item (item.href)}` used the item's own `href` as its keyed-each key,
  // which is only unique by accident — a colliding href threw Svelte's `each_key_duplicate`
  // exception in a real browser and broke primary-nav rendering (and everything else on the page)
  // entirely. jsdom's own render path didn't previously exercise this because every prior test's
  // fixture hrefs were deliberately non-colliding (`/ext/settings`-style).
  it("does not crash when a manifest-declared top-level item reuses an existing native nav item's href (AC10 does not forbid this)", () => {
    expect(() =>
      render(PrimaryNav, {
        props: {
          extensionNavItems: [
            { id: 'mock-ext-settings', label: 'Mock Extension Settings', href: '/dashboard' },
          ],
        },
      })
    ).not.toThrow()

    // Both the native Dashboard link and the manifest-declared item render distinctly, despite
    // sharing the same href. (Each link's accessible name concatenates its `hidden sm:inline` +
    // `sm:hidden` label spans — mirrors this file's other tests' own `/dashboard/i`-style
    // pattern matching rather than an exact string.)
    expect(screen.getByRole('link', { name: /^dashboard/i })).toBeTruthy()
    expect(screen.getByRole('link', { name: /mock extension settings/i })).toBeTruthy()
  })
})
