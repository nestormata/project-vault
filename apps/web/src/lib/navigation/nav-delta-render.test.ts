// Story 68.7 AC-2/AC-3/AC-4/AC-6/AC-7/AC-11/AC-14: every renderer family renders a CM delta from
// data, at any depth, with PV's accessibility kept: roles, names, `aria-current`, DOM order equal
// to data order, hidden items absent from the DOM, labels as escaped text, components as icons.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte'
import { flushSync } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLocale, setLocale } from '$lib/paraglide/runtime.js'
import { reactivePage } from '$lib/test/reactive-page.svelte.js'
import { testAuthUser } from '$lib/test/page-data.js'
import type { NavDelta, NavItem } from './types.js'

const holder = vi.hoisted(() => ({ delta: {} as unknown }))

vi.mock('$app/state', () => ({ page: reactivePage }))
vi.mock('$app/navigation', () => ({ goto: vi.fn(async () => undefined) }))
vi.mock('$lib/api/auth.js', () => ({ logout: vi.fn(async () => undefined) }))
vi.mock('$lib/navigation/active-delta.js', () => ({
  get activeDelta() {
    return holder.delta
  },
}))

import PrimaryNav from '$lib/components/shell/PrimaryNav.svelte'
import ProjectNav from '$lib/components/shell/ProjectNav.svelte'
import ShellAccount from '$lib/components/shell/ShellAccount.svelte'
import Footer from '$lib/components/shell/Footer.svelte'
import NotificationsLink from '$lib/components/shell/NotificationsLink.svelte'
import ShellBrand from '$lib/components/shell/ShellBrand.svelte'
import BackLink from '$lib/components/monitoring/BackLink.svelte'
import Breadcrumbs from './Breadcrumbs.svelte'
import NavCards from './NavCards.svelte'
import NavLinkRow from './NavLinkRow.svelte'
import NavTabs from './NavTabs.svelte'
import TestIcon from './fixtures/TestIcon.svelte'

const path = (value: string) => value as never

function useDelta(delta: NavDelta): void {
  holder.delta = delta
}

/** A CM subtree `depth` levels deep, every level a group except the deepest link. */
function subtree<C>(prefix: string, depth: number, leafHref: string): NavItem<C> {
  let node: NavItem<C> = {
    id: `${prefix}.l${depth}`,
    label: `L${depth}`,
    href: () => path(leafHref),
  }
  for (let level = depth - 1; level >= 1; level -= 1) {
    node = { id: `${prefix}.l${level}`, label: `L${level}`, children: [node] }
  }
  return node
}

/** The first element matching `selector` under `root`, failing the test when there is none. */
function one(root: ParentNode, selector: string): Element {
  const found = root.querySelector(selector)
  if (found === null) throw new Error(`no ${selector}`)
  return found
}

beforeEach(() => {
  reactivePage.url = new URL('http://localhost/dashboard')
  reactivePage.data = {}
})

afterEach(async () => {
  cleanup()
  useDelta({})
  await setLocale('en', { reload: false })
})

describe('primary nav with a CM delta (Story 68.7 AC-3)', () => {
  it('a 3-level CM subtree under primary.settings: details > details > a, current state bubbles up', () => {
    reactivePage.url = new URL('http://localhost/reports/daily')
    useDelta({
      primary: [
        { op: 'insert', parent: 'primary.settings', item: subtree('cm.r', 3, '/reports/daily') },
      ],
    })
    const { container } = render(PrimaryNav, { props: {} })
    const nav = screen.getByRole('navigation', { name: 'Primary navigation' })
    const outer = one(container, 'details')
    expect(one(outer, ':scope > summary').textContent).toContain('Settings')
    expect(one(outer, ':scope > summary').className).toContain('bg-brand-600')
    const panel = one(outer, ':scope > div')
    // PV's own Settings link stays first inside the disclosure (a group with an href).
    expect(one(panel, ':scope > a').getAttribute('href')).toBe('/settings')
    const level1 = one(panel, ':scope > details')
    expect(one(level1, ':scope > summary').textContent).toContain('L1')
    const level2 = one(level1, ':scope > div > details')
    expect(one(level2, ':scope > summary').textContent).toContain('L2')
    const leaf = within(nav).getByRole('link', { name: 'L3' })
    expect(leaf.getAttribute('aria-current')).toBe('page')
    expect(leaf.closest('details')).toBe(level2)
  })

  it('keeps DOM order equal to data order and removes hidden items from the DOM', () => {
    useDelta({
      primary: [
        { op: 'reorder', parent: 'primary', ids: ['primary.settings', 'primary.dashboard'] },
        { op: 'hide', id: 'primary.health' },
        { op: 'remove', id: 'primary.search' },
      ],
    })
    render(PrimaryNav, { props: {} })
    const nav = screen.getByRole('navigation', { name: 'Primary navigation' })
    const hrefs = [...nav.querySelectorAll('a')].map((link) => link.getAttribute('href'))
    expect(hrefs).toEqual([
      '/settings',
      '/dashboard',
      '/projects',
      '/credentials',
      '/notifications',
    ])
    expect(nav.querySelector('button')).toBeNull()
  })

  it('renders a CM label as escaped text, never as markup', () => {
    useDelta({
      primary: [
        { op: 'relabel', id: 'primary.health', label: () => '<img src=x onerror=alert(1)>' },
      ],
    })
    const { container } = render(PrimaryNav, { props: {} })
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('renders a CM icon component, and calls a CM action', async () => {
    const onSelect = vi.fn()
    useDelta({
      primary: [
        {
          op: 'insert',
          parent: 'primary',
          item: { id: 'cm.help', label: 'Help', icon: TestIcon, href: () => path('/help') },
        },
        {
          op: 'insert',
          parent: 'primary',
          item: { id: 'cm.chat', label: 'Chat', icon: TestIcon, onSelect },
        },
      ],
    })
    const { container } = render(PrimaryNav, { props: {} })
    expect(container.querySelectorAll('[data-test-icon]')).toHaveLength(2)
    await fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    expect(onSelect).toHaveBeenCalledOnce()
  })

  it('the legacy navItems tail still renders after the delta-applied items (Story 68.7 AC-11)', () => {
    useDelta({ primary: [{ op: 'hide', id: 'primary.health' }] })
    render(PrimaryNav, {
      props: { extensionNavItems: [{ id: 'ext-a', label: 'Ext', href: '/ext/a' }] },
    })
    const links = screen.getAllByRole('link').map((link) => link.getAttribute('href'))
    expect(links).not.toContain('/health')
    expect(links.at(-1)).toBe('/ext/a')
    expect(links.at(-2)).toBe('/settings')
  })

  it('a client navigation moves aria-current without a reload (Story 68.7 AC-14)', () => {
    render(PrimaryNav, { props: {} })
    expect(screen.getAllByRole('link', { current: 'page' })[0]?.getAttribute('href')).toBe(
      '/dashboard'
    )
    reactivePage.url = new URL('http://localhost/settings')
    flushSync()
    expect(screen.getAllByRole('link', { current: 'page' })[0]?.getAttribute('href')).toBe(
      '/settings'
    )
  })

  it('a CM relabel that reads the locale follows a no-reload locale switch (Story 68.7 AC-4)', async () => {
    useDelta({
      primary: [
        {
          op: 'relabel',
          id: 'primary.health',
          label: () => (getLocale() === 'es' ? 'Salud CM' : 'Health CM'),
        },
      ],
    })
    const { rerender } = render(PrimaryNav, { props: {} })
    expect(screen.getAllByText('Health CM').length).toBeGreaterThan(0)
    await setLocale('es', { reload: false })
    await rerender({})
    expect(screen.getAllByText('Salud CM').length).toBeGreaterThan(0)
  })
})

describe('the other renderer families render a 6-level CM tree (Story 68.7 AC-2/AC-3)', () => {
  const sixLevelLabels = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6']

  it('project tab bar: a disclosure tab whose panel nests the children', () => {
    useDelta({
      project: [{ op: 'insert', parent: 'project', item: subtree('cm.p', 6, '/projects/p1/x') }],
    })
    reactivePage.url = new URL('http://localhost/projects/p1/x')
    const { container } = render(ProjectNav, { props: { projectId: 'p1', orgRole: 'owner' } })
    expect(container.querySelectorAll('details')).toHaveLength(5)
    expect(screen.getByRole('link', { name: 'L6' }).getAttribute('aria-current')).toBe('page')
    expect([...container.querySelectorAll('summary')].map((s) => s.textContent?.trim())).toEqual(
      sixLevelLabels.slice(0, 5)
    )
  })

  it('account menu, utility cluster and footer: nested disclosures', () => {
    useDelta({
      account: [{ op: 'insert', after: 'account.sign-out', item: subtree('cm.a', 6, '/billing') }],
      'shell.utility': [
        { op: 'insert', parent: 'shell.utility', item: subtree('cm.u', 6, '/help') },
      ],
      footer: [{ op: 'insert', parent: 'footer', item: subtree('cm.f', 6, '/about') }],
    })
    for (const [component, props] of [
      [ShellAccount, { user: testAuthUser() }],
      [NotificationsLink, { unreadCount: 2 }],
      [Footer, {}],
    ] as const) {
      const { container, unmount } = render(component as never, { props } as never)
      expect(container.querySelectorAll('details')).toHaveLength(5)
      expect(within(container).getByRole('link', { name: 'L6' })).toBeTruthy()
      unmount()
    }
  })

  it('index cards: nested lists of cards; link rows: disclosures; tabs: disclosure tabs', () => {
    useDelta({
      'settings.index': [
        { op: 'insert', parent: 'settings.index', item: subtree('cm.s', 6, '/x') },
      ],
      'settings.audit.links': [
        { op: 'insert', parent: 'settings.audit.links', item: subtree('cm.l', 6, '/y') },
      ],
      'notifications.tabs': [
        { op: 'insert', parent: 'notifications.tabs', item: subtree('cm.t', 6, '/z') },
      ],
    })
    const cards = render(NavCards, { props: { surface: 'settings.index' } })
    expect(cards.container.querySelectorAll('ul')).toHaveLength(6)
    cards.unmount()
    const row = render(NavLinkRow, { props: { surface: 'settings.audit.links' } })
    expect(row.container.querySelectorAll('details')).toHaveLength(5)
    row.unmount()
    const tabs = render(NavTabs, { props: { status: 'all' } })
    expect(tabs.container.querySelectorAll('details')).toHaveLength(5)
    expect(within(tabs.container).getByRole('link', { name: 'L6' })).toBeTruthy()
  })

  it('breadcrumbs: a CM page under PV’s tree shows PV’s crumbs (design rule 8)', () => {
    useDelta({
      breadcrumbs: [
        {
          op: 'insert',
          parent: 'breadcrumbs.platform',
          item: { id: 'cm.reports', label: 'Reports', href: () => path('/reports') },
        },
      ],
    })
    const { container } = render(Breadcrumbs, { props: { node: 'cm.reports' } })
    // PlatformBreadcrumb's spacing on main: no space before the separator.
    expect(container.querySelector('nav')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Platform Admin› Reports'
    )
    expect(
      within(container).getByRole('link', { name: 'Platform Admin' }).getAttribute('href')
    ).toBe('/platform')
  })

  it('back links: children render as sibling links; a hidden back link renders nothing', () => {
    useDelta({
      back: [
        {
          op: 'insert',
          parent: 'back.project.service',
          item: {
            id: 'cm.back.extra',
            label: 'Back to billing',
            href: (ctx) => path(`/projects/${ctx.projectId}/billing`),
          },
        },
        { op: 'hide', id: 'back.project.domain' },
      ],
    })
    const shown = render(BackLink, { props: { node: 'back.project.service', projectId: 'p9' } })
    expect([...shown.container.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
      '/projects/p9/services',
      '/projects/p9/billing',
    ])
    shown.unmount()
    const hidden = render(BackLink, { props: { node: 'back.project.domain', projectId: 'p9' } })
    expect(hidden.container.querySelector('a')).toBeNull()
  })

  it('the brand link can be replaced; it stays text while the primary nav is hidden', () => {
    useDelta({
      'shell.brand': [
        {
          op: 'replace',
          id: 'shell.brand.home',
          item: { label: 'CentralizeMe', href: () => path('/') },
        },
      ],
    })
    const linked = render(ShellBrand, { props: {} })
    expect(
      within(linked.container).getByRole('link', { name: 'CentralizeMe' }).getAttribute('href')
    ).toBe('/')
    linked.unmount()
    const text = render(ShellBrand, { props: { hidePrimaryNav: true } })
    expect(text.container.querySelector('a')).toBeNull()
    expect(text.container.textContent).toContain('CentralizeMe')
  })

  it('a replaced sign-out runs the CM action', async () => {
    const onSelect = vi.fn()
    useDelta({
      account: [
        {
          op: 'replace',
          id: 'account.sign-out',
          item: { label: 'Leave', kind: 'action', onSelect },
        },
      ],
    })
    render(ShellAccount, { props: { user: testAuthUser() } })
    await fireEvent.click(screen.getByRole('button', { name: 'Leave' }))
    expect(onSelect).toHaveBeenCalledOnce()
  })
})
