// Story 72.6 (P3a): a top-level `group` renders as a section label, and an item may carry a badge
// or a status. The model (build-surface) evaluates both per render; the primary nav, the account
// menu and every NavEntry surface render them; a bad status is a bad item, never a silent default.
import { cleanup, render, screen, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocale } from '$lib/paraglide/runtime.js'
import { reactivePage } from '$lib/test/reactive-page.svelte.js'
import { testAuthUser } from '$lib/test/page-data.js'
import { renderSurface } from './build-surface.js'
import type { NavContexts, NavDelta } from './types.js'

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
import ShellAccount from '$lib/components/shell/ShellAccount.svelte'
import { path } from './nav-render-test-helpers.js'

function useDelta(delta: NavDelta): void {
  holder.delta = delta
}

const ctx: NavContexts['primary'] = {
  pathname: '/dashboard',
  user: { isPlatformOperator: false, orgRole: 'owner' },
  hasUiPanelExtension: false,
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

describe('badge and status in the nav model (Story 72.6)', () => {
  it('evaluates a string badge, a function badge per render and a status', () => {
    const nodes = renderSurface('primary', ctx, {
      delta: {
        primary: [
          {
            op: 'replace',
            id: 'primary.projects',
            item: {
              label: 'Projects',
              href: () => path('/projects'),
              badge: 'New',
              status: 'info',
            },
          },
          {
            op: 'replace',
            id: 'primary.health',
            item: {
              label: 'Health',
              href: () => path('/health'),
              badge: (c: NavContexts['primary']) => `at ${c.pathname}`,
            },
          },
        ],
      },
    })
    const projects = nodes.find((node) => node.id === 'primary.projects')
    expect(projects?.badge).toBe('New')
    expect(projects?.status).toBe('info')
    expect(nodes.find((node) => node.id === 'primary.health')?.badge).toBe('at /dashboard')
  })

  it('leaves both fields out of a node that sets neither (an empty badge counts as none)', () => {
    const nodes = renderSurface('primary', ctx, {
      delta: {
        primary: [
          {
            op: 'replace',
            id: 'primary.projects',
            item: { label: 'Projects', href: () => path('/projects'), badge: '' },
          },
        ],
      },
    })
    const node = nodes.find((entry) => entry.id === 'primary.projects')
    expect(node).toBeDefined()
    expect(node && 'badge' in node).toBe(false)
    expect(node && 'status' in node).toBe(false)
  })

  it('a status outside the four tones is a bad item: strict throws with the id, production drops it', () => {
    const delta = {
      primary: [
        {
          op: 'replace',
          id: 'primary.projects',
          item: { label: 'Projects', href: () => path('/projects'), status: 'purple' },
        },
      ],
    } as unknown as NavDelta
    expect(() => renderSurface('primary', ctx, { delta, strict: true })).toThrow(
      /primary\.projects.*status must be one of/
    )
    const nodes = renderSurface('primary', ctx, { delta, strict: false })
    expect(nodes.some((node) => node.id === 'primary.projects')).toBe(false)
  })
})

describe('the primary nav renders sections, badges and statuses (Story 72.6)', () => {
  it('a top-level group is a labelled role=group whose children follow it in data order', () => {
    useDelta({
      primary: [
        {
          op: 'insert',
          parent: 'primary',
          item: {
            id: 'cm.reports',
            label: 'Reports',
            children: [
              { id: 'cm.reports.daily', label: 'Daily', href: () => path('/reports/daily') },
              { id: 'cm.reports.weekly', label: 'Weekly', href: () => path('/reports/weekly') },
            ],
          },
        },
      ],
    })
    const { container } = render(PrimaryNav, { props: {} })
    const group = screen.getByRole('group', { name: 'Reports' })
    expect(
      within(group)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href'))
    ).toEqual(['/reports/daily', '/reports/weekly'])
    // A label, not a disclosure: no <details> for it, and the label is not a link or a button.
    expect(container.querySelector('details')).toBeNull()
    const label = group.querySelector(':scope > span')
    expect(label?.textContent).toBe('Reports')
    expect(label?.closest('a, button')).toBeNull()
  })

  it('a group nested in a section stays a disclosure, and an item with an href and children stays one', () => {
    useDelta({
      primary: [
        {
          op: 'insert',
          parent: 'primary',
          item: {
            id: 'cm.tools',
            label: 'Tools',
            children: [
              {
                id: 'cm.tools.inner',
                label: 'Inner',
                children: [{ id: 'cm.tools.leaf', label: 'Leaf', href: () => path('/leaf') }],
              },
            ],
          },
        },
        {
          op: 'insert',
          parent: 'primary.settings',
          item: { id: 'cm.settings.child', label: 'Child', href: () => path('/child') },
        },
      ],
    })
    const { container } = render(PrimaryNav, { props: {} })
    expect(screen.getByRole('group', { name: 'Tools' })).toBeTruthy()
    const summaries = [...container.querySelectorAll('summary')].map((s) => s.textContent?.trim())
    expect(summaries.some((text) => text?.includes('Inner'))).toBe(true)
    expect(summaries.some((text) => text?.includes('Settings'))).toBe(true)
  })

  it('shows a badge chip with its tone, a status dot with a screen-reader word, and nothing else', () => {
    useDelta({
      primary: [
        {
          op: 'replace',
          id: 'primary.projects',
          item: {
            label: 'Projects',
            href: () => path('/projects'),
            badge: '3',
            status: 'warning',
          },
        },
        {
          op: 'replace',
          id: 'primary.health',
          item: { label: 'Health', href: () => path('/health'), status: 'danger' },
        },
      ],
    })
    const { container } = render(PrimaryNav, { props: {} })
    expectChip(container)
    expectDot(container)
  })

  function expectChip(container: HTMLElement) {
    const chip = container.querySelector('[data-nav-badge]')
    expect(chip?.textContent?.trim()).toBe('3')
    expect(chip?.getAttribute('data-status')).toBe('warning')
    expect(chip?.className).toContain('bg-amber-100')
    // A chip with a status also names it, so the tone is not colour alone (", Needs attention").
    expect(chip?.nextElementSibling?.textContent).toBe(', Needs attention')
  }

  function expectDot(container: HTMLElement) {
    const dot = container.querySelector('[data-nav-status="danger"]')
    expect(dot?.getAttribute('aria-hidden')).toBe('true')
    expect(dot?.nextElementSibling?.className).toContain('sr-only')
    expect(dot?.nextElementSibling?.textContent).toBe(', Problem')
    // Items without either field render no badge markup.
    expect(container.querySelectorAll('[data-nav-badge], [data-nav-status]')).toHaveLength(2)
    expect(screen.getByRole('link', { name: /^Health.*, Problem$/ })).toBeTruthy()
  }

  it('the status word follows the locale', async () => {
    useDelta({
      primary: [
        {
          op: 'replace',
          id: 'primary.health',
          item: { label: 'Health', href: () => path('/health'), status: 'danger' },
        },
      ],
    })
    await setLocale('es', { reload: false })
    const { container } = render(PrimaryNav, { props: {} })
    expect(container.querySelector('[data-nav-status] + .sr-only')?.textContent).toBe(', Problema')
  })
})

describe('a section label and a disclosure summary show their badge (Story 72.6)', () => {
  it('shows the badge of a top-level group and of a group nested in a disclosure', () => {
    useDelta({
      primary: [
        {
          op: 'insert',
          parent: 'primary',
          item: {
            id: 'cm.tools',
            label: 'Tools',
            badge: '2',
            children: [
              {
                id: 'cm.tools.inner',
                label: 'Inner',
                badge: 'New',
                children: [{ id: 'cm.tools.leaf', label: 'Leaf', href: () => path('/leaf') }],
              },
            ],
          },
        },
      ],
    })
    const { container } = render(PrimaryNav, { props: {} })
    const chips = [...container.querySelectorAll('[data-nav-badge]')].map((el) =>
      el.textContent?.trim()
    )
    expect(chips).toEqual(['2', 'New'])
  })
})

describe('badge and status on the account menu (Story 72.6)', () => {
  it('a badge on an account item renders next to its label', () => {
    useDelta({
      account: [
        {
          op: 'insert',
          before: 'account.sign-out',
          item: {
            id: 'cm.account.billing',
            label: 'Billing',
            href: () => path('/billing'),
            badge: 'Due',
          },
        },
      ],
    })
    const { container } = render(ShellAccount, { props: { user: testAuthUser() } })
    const link = screen.getByRole('link', { name: /Billing/ })
    expect(link.querySelector('[data-nav-badge]')?.textContent?.trim()).toBe('Due')
    expect(container.querySelectorAll('[data-nav-badge]')).toHaveLength(1)
  })
})
