import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { createRawSnippet, type Component } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { INJECTION_POINTS } from '$lib/components/composition/injection-points.js'

// Story 69.6 AC-2: every top-level component use of a route file is its own region. Each wrapper
// renders the component it wraps UNCHANGED and, when given a `children` snippet (the page's own
// `<InjectionPoint>`), puts it right after that component without adding a DOM node. One table-driven
// test per behavior, over a shared `renderRegion` helper.

vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn() }))
vi.mock('$app/stores', () => ({
  navigating: { subscribe: (run: (value: unknown) => void) => (run(null), () => undefined) },
}))
vi.mock('$app/state', () => ({
  page: { route: { id: '/(app)/test' }, params: {}, url: new URL('http://localhost/') },
}))

type Loader = () => Promise<{ default: Component<never> }>

interface Case {
  /** The region's point name (rendered by the route file, never by the wrapper). */
  point: string
  load: Loader
  props: Record<string, unknown>
  /** A selector for the markup the wrapper must keep. */
  original: string
  /** The probe lands before the original (the page body of a layout), not after it. */
  probeFirst?: boolean
}

const noop = () => undefined
const CASES: Case[] = [
  {
    point: 'app.layout.search',
    load: () => import('$lib/components/shell/AppLayoutSearch.svelte'),
    props: { open: true },
    original: '[role="dialog"]',
  },
  {
    point: 'root.layout.progress',
    load: () => import('$lib/components/shell/RootLayoutProgress.svelte'),
    props: {},
    original: '',
  },
  {
    point: 'auth.layout.brand',
    load: () => import('$lib/components/shell/AuthLayoutBrand.svelte'),
    props: {},
    original: 'img',
  },
  {
    point: 'platform.home.nav-cards',
    load: () => import('$lib/components/shell/NavCardsRegion.svelte'),
    props: { surface: 'platform.index' },
    original: 'a',
  },
  {
    point: 'settings.home.nav-cards',
    load: () => import('$lib/components/shell/NavCardsRegion.svelte'),
    props: { surface: 'settings.index' },
    original: 'a',
  },
  {
    point: 'settings.language.back',
    load: () => import('$lib/components/shell/NavLinkRegion.svelte'),
    props: { surface: 'back', node: 'back.settings.language', class: 'back-link' },
    original: 'a.back-link',
  },
  {
    point: 'project.service-endpoints-detail.back',
    load: () => import('$lib/components/shell/BackLinkRegion.svelte'),
    props: { node: 'back.project.service-endpoint', projectId: 'p1' },
    original: 'a',
  },
  {
    point: 'auth.register.form',
    load: () => import('$lib/components/auth/RegisterFormRegion.svelte'),
    props: { prefillEmail: '', onLocaleChange: noop },
    original: 'form',
  },
  {
    point: 'vault.home.gate',
    load: () => import('$lib/components/vault/VaultGateRegion.svelte'),
    props: {
      readiness: { state: 'uninitialized', message: 'not set up' },
      onRetry: noop,
      onInit: noop,
      onUnseal: noop,
    },
    original: 'h1',
  },
  {
    point: 'platform.home.operator-notice',
    load: () => import('$lib/components/platform/PlatformOperatorNoticeRegion.svelte'),
    props: {},
    original: 'h1',
  },
  {
    point: 'platform.home.warnings',
    load: () => import('$lib/components/platform/PlatformWarningsRegion.svelte'),
    props: { warnings: ['w'], messages: { w: { message: 'Heads up' } } },
    original: '[role="alert"]',
  },
  {
    point: 'settings.security.enrollment',
    load: () => import('$lib/components/settings/SecurityEnrollmentRegion.svelte'),
    props: {
      initialUser: {
        id: 'u1',
        email: 'owner-user',
        orgId: 'o1',
        orgRole: 'owner',
        mfaEnrolled: false,
      },
    },
    original: 'button',
  },
  {
    point: 'project.certificates.list-header',
    load: () => import('$lib/components/monitoring/AssetListHeaderRegion.svelte'),
    props: {
      eyebrow: 'Certificates',
      title: 'SSL/TLS certificates',
      addHref: '/projects/p1/certificates/new',
      addLabel: 'Add certificate',
      canManage: true,
      description: 'Certificates tracked for expiry alerting.',
    },
    original: 'a',
  },
  {
    point: 'project.status-page.error',
    load: () => import('$lib/components/status-page/StatusPageErrorRegion.svelte'),
    props: { message: 'Something failed', class: 'alert-box' },
    original: 'p.alert-box',
  },
  {
    point: 'project.layout.content',
    load: () => import('$lib/components/shell/ProjectLayoutBody.svelte'),
    props: {
      body: createRawSnippet(() => ({ render: () => '<article data-body>routed page</article>' })),
    },
    original: '[data-body]',
    probeFirst: true,
  },
]

const probe = createRawSnippet(() => ({ render: () => '<span data-probe></span>' }))

async function renderRegion(testCase: Case, withChildren: boolean): Promise<HTMLElement> {
  const { default: Region } = await testCase.load()
  const props = { ...testCase.props, ...(withChildren ? { children: probe } : {}) }
  return render(Region as Component<Record<string, unknown>>, props).container
}

afterEach(() => cleanup())

describe('phase 6 region wrappers (G1 regions)', () => {
  it.each(CASES)(
    '$point: renders its original markup with and without a children snippet',
    async (testCase) => {
      const bare = await renderRegion(testCase, false)
      const bareHtml = bare.innerHTML
      expect(bare.querySelector('[data-probe]')).toBeNull()
      if (testCase.original !== '') expect(bare.querySelector(testCase.original)).not.toBeNull()
      cleanup()
      const filled = await renderRegion(testCase, true)
      expect(filled.querySelectorAll('[data-probe]')).toHaveLength(1)
      filled.querySelector('[data-probe]')?.remove()
      // The probe is the ONLY difference: the wrapper adds no element and no text of its own.
      expect(filled.innerHTML).toBe(bareHtml)
    }
  )

  it.each(CASES.filter((entry) => entry.original !== ''))(
    '$point: the probe sits on the expected side of the original (DOM order)',
    async (testCase) => {
      const container = await renderRegion(testCase, true)
      const original = container.querySelector(testCase.original) as Node
      const marker = container.querySelector('[data-probe]') as Node
      const order = original.compareDocumentPosition(marker)
      expect((order & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(testCase.probeFirst !== true)
    }
  )

  it('registers one region point per wrapper, none of them a standard position', () => {
    const regions = new Map(INJECTION_POINTS.map((point) => [point.name as string, point]))
    for (const { point } of CASES) {
      expect(regions.get(point)?.kind, point).toBe('region')
      expect(point).not.toMatch(/\.(before|after|header\.actions)$/)
    }
  })
})

describe('app.layout.search keeps the layout binding (Story 69.6 AC-2)', () => {
  it('opens on Ctrl/Cmd-K and closes on Escape with the probe beside it, and writes `open` back', async () => {
    const { default: Region } = await import('$lib/components/shell/AppLayoutSearch.svelte')
    const written: boolean[] = []
    render(Region, {
      open: false,
      children: probe,
    } as never)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
    const dialog = await screen.findByRole('dialog', { name: 'Global search' })
    expect(document.querySelectorAll('[data-probe]')).toHaveLength(1)
    await fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Global search' })).toBeNull()
    expect(document.querySelectorAll('[data-probe]')).toHaveLength(1)
    cleanup()
    render(Region, {
      get open() {
        return false
      },
      set open(next: boolean) {
        written.push(next)
      },
    } as never)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
    await screen.findByRole('dialog', { name: 'Global search' }).catch(() => null)
    expect(written).toContain(true)
  })
})
