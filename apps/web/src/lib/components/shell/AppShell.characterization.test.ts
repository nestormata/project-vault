// Story 68.5 AC-10: characterization of AppShell's rendered header BEFORE it is decomposed into
// ShellBrand / NotificationsLink / ShellAccount. The expected markup was captured from the
// pre-refactor component and must stay byte-identical after it. Svelte's empty comment anchors
// (`<!---->`) are not rendered DOM and shift when a block moves into a child component, so they
// are stripped; every element, attribute, class order and text node is compared as is.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/svelte'
import { createRawSnippet } from 'svelte'
import { setLocale } from '$lib/paraglide/runtime.js'

vi.mock('$app/navigation', () => ({ goto: vi.fn(async () => {}) }))
vi.mock('$lib/api/auth.js', () => ({ logout: vi.fn(async () => undefined) }))
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/dashboard') } }))

import type { AuthUser } from '$lib/api/auth.js'
import { testAuthUser } from '$lib/test/page-data.js'
import AppShell from './AppShell.svelte'

// Footer prints the current year; pin it so the snapshot does not rot on 1 January.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
})

afterEach(async () => {
  vi.useRealTimers()
  cleanup()
  await setLocale('en', { reload: false })
})

const children = createRawSnippet(() => ({ render: () => '<p>page body</p>' }))

interface Case {
  user?: Partial<AuthUser>
  hidePrimaryNav?: boolean
  unreadCount?: number
}

function markup(props: Case): string {
  const { user, ...rest } = props
  const { container } = render(AppShell, {
    props: {
      user: testAuthUser({ orgId: 'org-1', orgName: 'Acme Inc', orgRole: 'admin', ...user }),
      children,
      ...rest,
    },
  })
  return withoutComments(container).innerHTML.replaceAll('><', '>\n<')
}

// Svelte's hydration anchors are comment nodes; drop them by node type, not with a regexp over HTML.
function withoutComments(root: HTMLElement): HTMLElement {
  const copy = root.cloneNode(true) as HTMLElement
  const walker = copy.ownerDocument.createTreeWalker(copy, NodeFilter.SHOW_COMMENT)
  const comments: Node[] = []
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) comments.push(node)
  for (const comment of comments) comment.parentNode?.removeChild(comment)
  return copy
}

const MFA = {
  enrollmentRequired: true,
  gracePeriodActive: true,
  gracePeriodExpiresAt: null,
  gracePeriodDaysRemaining: 3,
  bannerMessage: 'Enroll in MFA at /settings/security before Friday.',
}

describe('AppShell characterization (AC-10)', () => {
  it('renders the same markup before and after the header decomposition', () => {
    const cases: Record<string, Case> = {
      'full header, no unread': { unreadCount: 0 },
      'full header, 5 unread': { unreadCount: 5 },
      'full header, 120 unread': { unreadCount: 120 },
      hidePrimaryNav: { hidePrimaryNav: true, unreadCount: 5 },
      'MFA banner with settings link': { user: { mfaStatus: MFA } },
      'MFA banner without settings link': {
        hidePrimaryNav: true,
        user: { mfaStatus: { ...MFA, bannerMessage: 'Enroll soon.' } },
      },
    }
    const rendered = Object.fromEntries(
      Object.entries(cases).map(([name, props]) => {
        const html = markup(props)
        cleanup()
        return [name, html]
      })
    )
    expect(rendered).toMatchInlineSnapshot(`
      {
        "MFA banner with settings link": "<div class="min-h-screen bg-slate-50 text-slate-950">
      <header class="border-b border-slate-200 bg-white">
      <div class="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 md:flex-row md:items-center md:justify-between">
      <div>
      <div class="flex items-center gap-2">
      <img alt="" width="276" height="240" class="h-8 w-auto" src="/logo-mark.png"> <a class="text-xl font-bold text-brand-600" href="/dashboard">Project Vault</a>
      </div> <p class="text-sm text-slate-600">Run complex projects. Miss nothing.</p>
      </div> <nav aria-label="Primary navigation" data-testid="primary-nav" class="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
      <button class="flex min-h-11 min-w-11 items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-sm font-medium text-slate-800" type="button" aria-label="Search (⌘K)" title="Search (⌘K)">
      <span aria-hidden="true">⌕</span> <span class="sr-only">Search</span> <kbd class="hidden rounded border border-slate-300 px-1 text-xs sm:inline" aria-hidden="true">⌘K</kbd>
      </button>  <a class="flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium bg-brand-600 text-white" aria-current="page" href="/dashboard"> <span class="hidden sm:inline">Dashboard</span> <span class="sm:hidden">Dashboard</span>
      </a>
      <a class="flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100" href="/projects"> <span class="hidden sm:inline">Projects</span> <span class="sm:hidden">Projects</span>
      </a>
      <a class="flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100" href="/credentials"> <span class="hidden sm:inline">Secrets</span> <span class="sm:hidden">Secrets</span>
      </a>
      <a class="flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100" href="/notifications"> <span class="hidden sm:inline">Notifications</span> <span class="sm:hidden">Notifications</span>
      </a>
      <a class="flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100" href="/health"> <span class="hidden sm:inline">Health</span> <span class="sm:hidden">Health</span>
      </a>
      <a class="flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100" href="/settings"> <span class="hidden sm:inline">Settings</span> <span class="sm:hidden">Settings</span>
      </a>
      </nav> <div class="flex flex-wrap items-center gap-3 text-sm text-slate-600">
      <a class="relative rounded-full p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700" aria-label="Notifications" href="/notifications">
      <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
      <path stroke-linecap="round" stroke-linejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9">
      </path>
      </svg> </a> <span>Role: admin</span> <span class="max-w-full break-all">Org: Acme Inc</span> <button class="rounded-xl border border-slate-300 px-3 py-2 font-medium text-slate-800" type="button">Sign out</button>
      </div>
      </div> <div class="border-t border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">Enroll in MFA at <a class="font-medium underline" href="/settings/security">/settings/security</a> before Friday.</div> </header> <main class="mx-auto max-w-7xl px-4 py-6">
      <p>page body</p>
      </main> <div class="border-t border-slate-200">
      <footer class="flex flex-col items-center justify-center gap-2 px-4 py-4 text-sm text-slate-500 sm:flex-row sm:gap-4">
      <p>© 2026 Project Vault</p> <a href="https://github.com/nestormata/project-vault" target="_blank" rel="noopener noreferrer" class="text-brand-600 hover:text-brand-700">GitHub</a> <a href="https://github.com/nestormata/project-vault/blob/main/LICENSE" target="_blank" rel="noopener noreferrer" class="text-brand-600 hover:text-brand-700">AGPL-3.0</a>
      </footer>
      </div>
      </div>",
        "MFA banner without settings link": "<div class="min-h-screen bg-slate-50 text-slate-950">
      <header class="border-b border-slate-200 bg-white">
      <div class="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 md:flex-row md:items-center md:justify-between">
      <div>
      <div class="flex items-center gap-2">
      <img alt="" width="276" height="240" class="h-8 w-auto" src="/logo-mark.png"> <p class="text-xl font-bold text-brand-600">Project Vault</p>
      </div> <p class="text-sm text-slate-600">Run complex projects. Miss nothing.</p>
      </div>  <div class="flex flex-wrap items-center gap-3 text-sm text-slate-600"> <span>Role: admin</span> <span class="max-w-full break-all">Org: Acme Inc</span> <button class="rounded-xl border border-slate-300 px-3 py-2 font-medium text-slate-800" type="button">Sign out</button>
      </div>
      </div> <div class="border-t border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">Enroll soon.</div> </header> <main class="p-0">
      <p>page body</p>
      </main> <div class="border-t border-slate-200">
      <footer class="flex flex-col items-center justify-center gap-2 px-4 py-4 text-sm text-slate-500 sm:flex-row sm:gap-4">
      <p>© 2026 Project Vault</p> <a href="https://github.com/nestormata/project-vault" target="_blank" rel="noopener noreferrer" class="text-brand-600 hover:text-brand-700">GitHub</a> <a href="https://github.com/nestormata/project-vault/blob/main/LICENSE" target="_blank" rel="noopener noreferrer" class="text-brand-600 hover:text-brand-700">AGPL-3.0</a>
      </footer>
      </div>
      </div>",
        "full header, 120 unread": "<div class="min-h-screen bg-slate-50 text-slate-950">
      <header class="border-b border-slate-200 bg-white">
      <div class="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 md:flex-row md:items-center md:justify-between">
      <div>
      <div class="flex items-center gap-2">
      <img alt="" width="276" height="240" class="h-8 w-auto" src="/logo-mark.png"> <a class="text-xl font-bold text-brand-600" href="/dashboard">Project Vault</a>
      </div> <p class="text-sm text-slate-600">Run complex projects. Miss nothing.</p>
      </div> <nav aria-label="Primary navigation" data-testid="primary-nav" class="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
      <button class="flex min-h-11 min-w-11 items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-sm font-medium text-slate-800" type="button" aria-label="Search (⌘K)" title="Search (⌘K)">
      <span aria-hidden="true">⌕</span> <span class="sr-only">Search</span> <kbd class="hidden rounded border border-slate-300 px-1 text-xs sm:inline" aria-hidden="true">⌘K</kbd>
      </button>  <a class="flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium bg-brand-600 text-white" aria-current="page" href="/dashboard"> <span class="hidden sm:inline">Dashboard</span> <span class="sm:hidden">Dashboard</span>
      </a>
      <a class="flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100" href="/projects"> <span class="hidden sm:inline">Projects</span> <span class="sm:hidden">Projects</span>
      </a>
      <a class="flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100" href="/credentials"> <span class="hidden sm:inline">Secrets</span> <span class="sm:hidden">Secrets</span>
      </a>
      <a class="flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100" href="/notifications"> <span class="hidden sm:inline">Notifications</span> <span class="sm:hidden">Notifications</span>
      </a>
      <a class="flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100" href="/health"> <span class="hidden sm:inline">Health</span> <span class="sm:hidden">Health</span>
      </a>
      <a class="flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100" href="/settings"> <span class="hidden sm:inline">Settings</span> <span class="sm:hidden">Settings</span>
      </a>
      </nav> <div class="flex flex-wrap items-center gap-3 text-sm text-slate-600">
      <a class="relative rounded-full p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700" aria-label="Notifications" href="/notifications">
      <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
      <path stroke-linecap="round" stroke-linejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9">
      </path>
      </svg> <span class="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-xs font-medium text-white">99+</span>
      </a> <span>Role: admin</span> <span class="max-w-full break-all">Org: Acme Inc</span> <button class="rounded-xl border border-slate-300 px-3 py-2 font-medium text-slate-800" type="button">Sign out</button>
      </div>
      </div>  </header> <main class="mx-auto max-w-7xl px-4 py-6">
      <p>page body</p>
      </main> <div class="border-t border-slate-200">
      <footer class="flex flex-col items-center justify-center gap-2 px-4 py-4 text-sm text-slate-500 sm:flex-row sm:gap-4">
      <p>© 2026 Project Vault</p> <a href="https://github.com/nestormata/project-vault" target="_blank" rel="noopener noreferrer" class="text-brand-600 hover:text-brand-700">GitHub</a> <a href="https://github.com/nestormata/project-vault/blob/main/LICENSE" target="_blank" rel="noopener noreferrer" class="text-brand-600 hover:text-brand-700">AGPL-3.0</a>
      </footer>
      </div>
      </div>",
        "full header, 5 unread": "<div class="min-h-screen bg-slate-50 text-slate-950">
      <header class="border-b border-slate-200 bg-white">
      <div class="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 md:flex-row md:items-center md:justify-between">
      <div>
      <div class="flex items-center gap-2">
      <img alt="" width="276" height="240" class="h-8 w-auto" src="/logo-mark.png"> <a class="text-xl font-bold text-brand-600" href="/dashboard">Project Vault</a>
      </div> <p class="text-sm text-slate-600">Run complex projects. Miss nothing.</p>
      </div> <nav aria-label="Primary navigation" data-testid="primary-nav" class="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
      <button class="flex min-h-11 min-w-11 items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-sm font-medium text-slate-800" type="button" aria-label="Search (⌘K)" title="Search (⌘K)">
      <span aria-hidden="true">⌕</span> <span class="sr-only">Search</span> <kbd class="hidden rounded border border-slate-300 px-1 text-xs sm:inline" aria-hidden="true">⌘K</kbd>
      </button>  <a class="flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium bg-brand-600 text-white" aria-current="page" href="/dashboard"> <span class="hidden sm:inline">Dashboard</span> <span class="sm:hidden">Dashboard</span>
      </a>
      <a class="flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100" href="/projects"> <span class="hidden sm:inline">Projects</span> <span class="sm:hidden">Projects</span>
      </a>
      <a class="flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100" href="/credentials"> <span class="hidden sm:inline">Secrets</span> <span class="sm:hidden">Secrets</span>
      </a>
      <a class="flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100" href="/notifications"> <span class="hidden sm:inline">Notifications</span> <span class="sm:hidden">Notifications</span>
      </a>
      <a class="flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100" href="/health"> <span class="hidden sm:inline">Health</span> <span class="sm:hidden">Health</span>
      </a>
      <a class="flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100" href="/settings"> <span class="hidden sm:inline">Settings</span> <span class="sm:hidden">Settings</span>
      </a>
      </nav> <div class="flex flex-wrap items-center gap-3 text-sm text-slate-600">
      <a class="relative rounded-full p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700" aria-label="Notifications" href="/notifications">
      <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
      <path stroke-linecap="round" stroke-linejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9">
      </path>
      </svg> <span class="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-xs font-medium text-white">5</span>
      </a> <span>Role: admin</span> <span class="max-w-full break-all">Org: Acme Inc</span> <button class="rounded-xl border border-slate-300 px-3 py-2 font-medium text-slate-800" type="button">Sign out</button>
      </div>
      </div>  </header> <main class="mx-auto max-w-7xl px-4 py-6">
      <p>page body</p>
      </main> <div class="border-t border-slate-200">
      <footer class="flex flex-col items-center justify-center gap-2 px-4 py-4 text-sm text-slate-500 sm:flex-row sm:gap-4">
      <p>© 2026 Project Vault</p> <a href="https://github.com/nestormata/project-vault" target="_blank" rel="noopener noreferrer" class="text-brand-600 hover:text-brand-700">GitHub</a> <a href="https://github.com/nestormata/project-vault/blob/main/LICENSE" target="_blank" rel="noopener noreferrer" class="text-brand-600 hover:text-brand-700">AGPL-3.0</a>
      </footer>
      </div>
      </div>",
        "full header, no unread": "<div class="min-h-screen bg-slate-50 text-slate-950">
      <header class="border-b border-slate-200 bg-white">
      <div class="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 md:flex-row md:items-center md:justify-between">
      <div>
      <div class="flex items-center gap-2">
      <img alt="" width="276" height="240" class="h-8 w-auto" src="/logo-mark.png"> <a class="text-xl font-bold text-brand-600" href="/dashboard">Project Vault</a>
      </div> <p class="text-sm text-slate-600">Run complex projects. Miss nothing.</p>
      </div> <nav aria-label="Primary navigation" data-testid="primary-nav" class="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
      <button class="flex min-h-11 min-w-11 items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-sm font-medium text-slate-800" type="button" aria-label="Search (⌘K)" title="Search (⌘K)">
      <span aria-hidden="true">⌕</span> <span class="sr-only">Search</span> <kbd class="hidden rounded border border-slate-300 px-1 text-xs sm:inline" aria-hidden="true">⌘K</kbd>
      </button>  <a class="flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium bg-brand-600 text-white" aria-current="page" href="/dashboard"> <span class="hidden sm:inline">Dashboard</span> <span class="sm:hidden">Dashboard</span>
      </a>
      <a class="flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100" href="/projects"> <span class="hidden sm:inline">Projects</span> <span class="sm:hidden">Projects</span>
      </a>
      <a class="flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100" href="/credentials"> <span class="hidden sm:inline">Secrets</span> <span class="sm:hidden">Secrets</span>
      </a>
      <a class="flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100" href="/notifications"> <span class="hidden sm:inline">Notifications</span> <span class="sm:hidden">Notifications</span>
      </a>
      <a class="flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100" href="/health"> <span class="hidden sm:inline">Health</span> <span class="sm:hidden">Health</span>
      </a>
      <a class="flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100" href="/settings"> <span class="hidden sm:inline">Settings</span> <span class="sm:hidden">Settings</span>
      </a>
      </nav> <div class="flex flex-wrap items-center gap-3 text-sm text-slate-600">
      <a class="relative rounded-full p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700" aria-label="Notifications" href="/notifications">
      <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
      <path stroke-linecap="round" stroke-linejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9">
      </path>
      </svg> </a> <span>Role: admin</span> <span class="max-w-full break-all">Org: Acme Inc</span> <button class="rounded-xl border border-slate-300 px-3 py-2 font-medium text-slate-800" type="button">Sign out</button>
      </div>
      </div>  </header> <main class="mx-auto max-w-7xl px-4 py-6">
      <p>page body</p>
      </main> <div class="border-t border-slate-200">
      <footer class="flex flex-col items-center justify-center gap-2 px-4 py-4 text-sm text-slate-500 sm:flex-row sm:gap-4">
      <p>© 2026 Project Vault</p> <a href="https://github.com/nestormata/project-vault" target="_blank" rel="noopener noreferrer" class="text-brand-600 hover:text-brand-700">GitHub</a> <a href="https://github.com/nestormata/project-vault/blob/main/LICENSE" target="_blank" rel="noopener noreferrer" class="text-brand-600 hover:text-brand-700">AGPL-3.0</a>
      </footer>
      </div>
      </div>",
        "hidePrimaryNav": "<div class="min-h-screen bg-slate-50 text-slate-950">
      <header class="border-b border-slate-200 bg-white">
      <div class="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 md:flex-row md:items-center md:justify-between">
      <div>
      <div class="flex items-center gap-2">
      <img alt="" width="276" height="240" class="h-8 w-auto" src="/logo-mark.png"> <p class="text-xl font-bold text-brand-600">Project Vault</p>
      </div> <p class="text-sm text-slate-600">Run complex projects. Miss nothing.</p>
      </div>  <div class="flex flex-wrap items-center gap-3 text-sm text-slate-600"> <span>Role: admin</span> <span class="max-w-full break-all">Org: Acme Inc</span> <button class="rounded-xl border border-slate-300 px-3 py-2 font-medium text-slate-800" type="button">Sign out</button>
      </div>
      </div>  </header> <main class="p-0">
      <p>page body</p>
      </main> <div class="border-t border-slate-200">
      <footer class="flex flex-col items-center justify-center gap-2 px-4 py-4 text-sm text-slate-500 sm:flex-row sm:gap-4">
      <p>© 2026 Project Vault</p> <a href="https://github.com/nestormata/project-vault" target="_blank" rel="noopener noreferrer" class="text-brand-600 hover:text-brand-700">GitHub</a> <a href="https://github.com/nestormata/project-vault/blob/main/LICENSE" target="_blank" rel="noopener noreferrer" class="text-brand-600 hover:text-brand-700">AGPL-3.0</a>
      </footer>
      </div>
      </div>",
      }
    `)
  })
})
