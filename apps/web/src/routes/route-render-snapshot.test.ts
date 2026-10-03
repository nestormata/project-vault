import { cleanup, render } from '@testing-library/svelte'
import { createRawSnippet } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Story 68.4 AC-12: PV's own rendered output must not change when the injection points land. This
// renders EVERY route file (page, layout, error) against a permissive empty `data` and snapshots the
// normalized markup, or the first line of the error when the file cannot render without real data
// (a stable outcome too). The snapshot was generated from `main` @ 3699ebbb BEFORE any route edit and
// is committed first; after the edits the same text must come out. Normalization removes only comment
// nodes (Svelte's SSR/hydration markers) and script bodies, and masks email-shaped placeholder text.

vi.mock('$app/state', () => ({
  page: {
    status: 404,
    error: { message: 'Not Found' },
    data: {},
    params: {},
    url: new URL('http://localhost/'),
    route: { id: null },
    form: null,
    state: {},
  },
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

const routes = import.meta.glob('./**/+{page,layout,error}.svelte', { eager: true }) as Record<
  string,
  { default: never }
>

/** An empty, permissive stand-in for any `data` shape: every property is another such value, it
 * iterates as empty and converts to an empty string. Where the page still needs real data, the
 * resulting error line is the (stable) outcome that is snapshotted. */
function permissive(): unknown {
  const target = function () {
    return permissive()
  }
  const proxy: unknown = new Proxy(target, {
    get(_target, key) {
      if (key === Symbol.iterator) return function* () {}
      if (key === Symbol.toPrimitive) return () => ''
      if (key === 'length') return 0
      if (key === 'then') return undefined
      if (key === 'toJSON') return () => null
      return permissive()
    },
    has: () => true,
  })
  return proxy
}

function normalize(html: string): string {
  return (
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<script[\s\S]*?<\/script>/g, '<script></script>')
      // Placeholder addresses in form fields are text, not contact data worth committing verbatim.
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

const children = createRawSnippet(() => ({ render: () => '<span data-child></span>' }))

function outcome(component: never, isLayout: boolean): string {
  try {
    const { container } = render(component, {
      data: permissive(),
      form: null,
      ...(isLayout ? { children } : {}),
    } as never)
    return normalize(container.innerHTML)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `THROWS: ${message.split('\n')[0]?.slice(0, 120) ?? ''}`
  } finally {
    cleanup()
  }
}

afterEach(cleanup)

describe('route render snapshot (Story 68.4 AC-12)', () => {
  it('covers every one of the 70 route files', () => {
    expect(Object.keys(routes)).toHaveLength(70)
  })

  it('renders every route file exactly as it did before the injection points existed', async () => {
    const result = Object.fromEntries(
      Object.entries(routes)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([file, module]) => [
          file,
          outcome(
            module.default,
            !file.endsWith('+page.svelte') && !file.endsWith('+error.svelte')
          ),
        ])
    )
    await expect(`${JSON.stringify(result, null, 2)}\n`).toMatchFileSnapshot(
      './__tests__/route-render.snapshot.json'
    )
    expect(Object.keys(result)).toHaveLength(70)
  })
})
