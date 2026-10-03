// Story 68.7 AC-3: the rendered-HTML oracle of every nav surface renderer, committed RED-first on
// `main`'s renderers BEFORE any of them moved onto nav data. It renders each renderer (and each page
// that renders a nav surface) over its context matrix and snapshots the normalized markup; after the
// conversion the same text must come out (PV's own image is unchanged, AC-12). Normalization walks
// the parsed DOM (`serializeWithoutNoise`: Svelte's comment anchors removed, never regex over HTML)
// and collapses whitespace runs, which Svelte itself collapses between inline siblings.
//
// The snapshot is never regenerated to make a conversion pass: a diff here is a PV markup change.
// Valid only on PV's own un-composed tree (scripts/lib/web-host/test-selection.ts PV_TREE_ONLY_TESTS).
import { cleanup, render } from '@testing-library/svelte'
import { createRawSnippet, type Component } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serializeWithoutNoise } from '$lib/test/dom.js'
import { testAuthUser } from '$lib/test/page-data.js'
import { setLocale } from '$lib/paraglide/runtime.js'

const pageState = vi.hoisted(() => ({
  page: {
    status: 200,
    error: null as { message: string } | null,
    data: {} as Record<string, unknown>,
    params: {},
    url: new URL('http://localhost/dashboard'),
    route: { id: null },
    form: null,
    state: {},
  },
}))

vi.mock('$app/state', () => ({
  page: pageState.page,
  navigating: { to: null },
  updated: { current: false },
}))
vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
  invalidate: vi.fn(),
  invalidateAll: vi.fn(),
  beforeNavigate: vi.fn(),
  afterNavigate: vi.fn(),
  onNavigate: vi.fn(),
  pushState: vi.fn(),
  replaceState: vi.fn(),
  preloadData: vi.fn(),
  preloadCode: vi.fn(),
}))
vi.mock('$app/forms', () => ({
  enhance: () => ({ destroy: () => undefined }),
  applyAction: vi.fn(),
  deserialize: vi.fn(),
}))
vi.mock('$lib/api/auth.js', () => ({ logout: vi.fn(async () => undefined) }))

import AppShell from '$lib/components/shell/AppShell.svelte'
import Footer from '$lib/components/shell/Footer.svelte'
import NotificationsLink from '$lib/components/shell/NotificationsLink.svelte'
import PrimaryNav from '$lib/components/shell/PrimaryNav.svelte'
import ProjectNav from '$lib/components/shell/ProjectNav.svelte'
import ShellAccount from '$lib/components/shell/ShellAccount.svelte'
import ShellBrand from '$lib/components/shell/ShellBrand.svelte'
import PlatformBreadcrumb from '$lib/components/platform/PlatformBreadcrumb.svelte'
import PlatformSettingsBreadcrumb from '$lib/components/platform/PlatformSettingsBreadcrumb.svelte'
import AssetDetailFooter from '$lib/components/monitoring/AssetDetailFooter.svelte'
import ErrorPage from '../../routes/+error.svelte'
import LoginPage from '../../routes/(auth)/login/+page.svelte'
import RegisterPage from '../../routes/(auth)/register/+page.svelte'
import RecoveryPage from '../../routes/(auth)/recovery/+page.svelte'
import SettingsIndexPage from '../../routes/(app)/settings/+page.svelte'
import SettingsAuditPage from '../../routes/(app)/settings/audit/+page.svelte'
import PlatformIndexPage from '../../routes/(app)/platform/+page.svelte'
import PlatformSettingsPage from '../../routes/(app)/platform/settings/+page.svelte'
import PlatformUpgradePage from '../../routes/(app)/platform/upgrade/+page.svelte'
import NotificationsPage from '../../routes/(app)/notifications/+page.svelte'

const body = createRawSnippet(() => ({ render: () => '<p data-child>body</p>' }))

/** An empty, permissive stand-in for any `data` shape (the 68-4 route oracle's), with the fields a
 * case needs set to real values. */
function permissive(overrides: Record<string, unknown> = {}): unknown {
  const fields = new Map(Object.entries(overrides))
  const target = function () {
    return permissive()
  }
  return new Proxy(target, {
    get(_target, key) {
      if (typeof key === 'string' && fields.has(key)) return fields.get(key)
      if (key === Symbol.iterator) return function* () {}
      if (key === Symbol.toPrimitive) return () => ''
      if (key === 'length') return 0
      if (key === 'then') return undefined
      if (key === 'toJSON') return () => null
      return permissive()
    },
    has: () => true,
  })
}

function normalize(root: Element): string {
  return serializeWithoutNoise(root).replace(/\s+/g, ' ').trim()
}

function markup(component: unknown, props: Record<string, unknown>): string {
  try {
    const { container } = render(component as Component<Record<string, unknown>>, { props })
    return normalize(container)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `THROWS: ${message.split('\n')[0]?.slice(0, 120) ?? ''}`
  } finally {
    cleanup()
  }
}

function at(pathname: string, data: Record<string, unknown> = {}, status = 200): void {
  pageState.page.url = new URL(`http://localhost${pathname}`)
  pageState.page.data = data
  pageState.page.status = status
  pageState.page.error = status === 200 ? null : { message: 'x' }
}

const PATHS = ['/dashboard', '/projects/p1', '/projects/p1/members', '/platform/backups', '/health']
const BOOLS = [false, true]

function shellCases(out: Map<string, string>): void {
  for (const pathname of PATHS) {
    at(pathname)
    for (const isPlatformOperator of BOOLS) {
      for (const hasUiPanelExtension of BOOLS) {
        out.set(
          `PrimaryNav ${pathname} operator=${isPlatformOperator} panel=${hasUiPanelExtension}`,
          markup(PrimaryNav, { isPlatformOperator, hasUiPanelExtension })
        )
      }
    }
    for (const orgRole of ['owner', 'admin', 'member', 'viewer']) {
      for (const isArchived of BOOLS) {
        out.set(
          `ProjectNav ${pathname} role=${orgRole} archived=${isArchived}`,
          markup(ProjectNav, { projectId: 'p1', orgRole, isArchived })
        )
      }
    }
  }
  for (const hidePrimaryNav of BOOLS) {
    out.set(`ShellBrand hide=${hidePrimaryNav}`, markup(ShellBrand, { hidePrimaryNav }))
  }
  for (const unreadCount of [0, 7, 150]) {
    out.set(`NotificationsLink ${unreadCount}`, markup(NotificationsLink, { unreadCount }))
  }
  out.set('ShellAccount', markup(ShellAccount, { user: testAuthUser({ orgRole: 'admin' }) }))
  out.set('Footer', markup(Footer, {}))
}

const BANNERS: [string, Record<string, unknown>][] = [
  ['none', {}],
  [
    'with-path',
    {
      bannerMessage: 'Enroll in MFA at /settings/security within 3 days.',
      gracePeriodActive: true,
    },
  ],
  ['no-path', { bannerMessage: 'MFA is required.' }],
  ['enrollment-only', { enrollmentRequired: true }],
]

function appShellCases(out: Map<string, string>): void {
  at('/settings')
  for (const [name, mfa] of BANNERS) {
    for (const hidePrimaryNav of BOOLS) {
      const user = testAuthUser({ isPlatformOperator: name === 'none' })
      const mfaStatus = { ...user.mfaStatus, ...mfa }
      out.set(
        `AppShell banner=${name} hide=${hidePrimaryNav}`,
        markup(AppShell, {
          user: { ...user, mfaStatus },
          children: body,
          hidePrimaryNav,
          unreadCount: 3,
          hasUiPanelExtension: true,
        })
      )
    }
  }
}

function breadcrumbCases(out: Map<string, string>): void {
  at('/platform/audit')
  out.set(
    'PlatformBreadcrumb two',
    markup(PlatformBreadcrumb, {
      allowed: true,
      trail: [{ label: 'Platform Admin', href: '/platform' }, { label: 'Backups' }],
      children: body,
    })
  )
  out.set(
    'PlatformBreadcrumb denied',
    markup(PlatformBreadcrumb, { allowed: false, trail: [], children: body })
  )
  out.set(
    'PlatformSettingsBreadcrumb',
    markup(PlatformSettingsBreadcrumb, {
      allowed: true,
      leafLabel: 'Organizations',
      children: body,
    })
  )
  out.set(
    'AssetDetailFooter',
    markup(AssetDetailFooter, {
      canManage: false,
      deleteError: null,
      onDelete: () => undefined,
      backHref: '/projects/p1/services',
      backLabel: 'Back to services',
    })
  )
}

function pageCases(out: Map<string, string>): void {
  for (const authenticated of BOOLS) {
    for (const status of [404, 500]) {
      at('/nowhere', authenticated ? { user: { userId: 'u1' } } : {}, status)
      out.set(`error authenticated=${authenticated} status=${status}`, markup(ErrorPage, {}))
    }
  }
  at('/login')
  out.set('login', markup(LoginPage, { data: permissive(), form: null }))
  out.set('register', markup(RegisterPage, { data: permissive(), form: null }))
  out.set('recovery', markup(RecoveryPage, { data: permissive(), form: null }))
  at('/settings')
  out.set('settings index', markup(SettingsIndexPage, { data: permissive() }))
  at('/settings/audit')
  for (const allowed of BOOLS) {
    out.set(
      `settings audit allowed=${allowed}`,
      markup(SettingsAuditPage, {
        data: permissive({ allowed, orgRole: 'admin', errorMessage: null }),
        form: null,
      })
    )
  }
  at('/platform')
  for (const allowed of BOOLS) {
    out.set(
      `platform index allowed=${allowed}`,
      markup(PlatformIndexPage, { data: permissive({ allowed, warnings: [] }) })
    )
  }
  at('/platform/settings')
  out.set(
    'platform settings',
    markup(PlatformSettingsPage, { data: permissive({ allowed: true }), form: null })
  )
  at('/platform/upgrade')
  out.set(
    'platform upgrade',
    markup(PlatformUpgradePage, { data: permissive({ allowed: true }), form: null })
  )
  for (const status of ['all', 'unread', 'read']) {
    at('/notifications')
    out.set(
      `notifications status=${status}`,
      markup(NotificationsPage, {
        data: permissive({ status, notifications: [], page: 1, totalPages: 1 }),
        form: null,
      })
    )
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
})

afterEach(async () => {
  vi.useRealTimers()
  cleanup()
  await setLocale('en', { reload: false })
})

describe('nav render oracle (Story 68.7 AC-3)', () => {
  it('renders every nav surface exactly as main did, over its context matrix', async () => {
    const out = new Map<string, string>()
    shellCases(out)
    appShellCases(out)
    breadcrumbCases(out)
    pageCases(out)
    await setLocale('es', { reload: false })
    at('/dashboard')
    out.set('PrimaryNav es operator=true', markup(PrimaryNav, { isPlatformOperator: true }))
    const text = `${JSON.stringify(Object.fromEntries(out), null, 2)}\n`
    await expect(text).toMatchFileSnapshot('./nav-render-oracle.snapshot.json')
    expect(out.size).toBeGreaterThan(90)
  })
})
