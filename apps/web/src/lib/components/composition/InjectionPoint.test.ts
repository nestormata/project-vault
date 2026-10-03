import { render } from '@testing-library/svelte'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { serializeWithoutNoise } from '$lib/test/dom.js'
import { sampleProject } from '$lib/test/fixtures.js'
import PointHost from '$lib/test/injection/PointHost.svelte'
import TileA from '$lib/test/injection/TileA.svelte'
import TileB from '$lib/test/injection/TileB.svelte'
import TileHead from '$lib/test/injection/TileHead.svelte'
import TileThrows from '$lib/test/injection/TileThrows.svelte'
import type { InjectionEntry } from './injection-points.js'

// Story 68.4 AC-1 / AC-11: the point renders its contributions as dynamic components, with no
// wrapper element and no boundary of any kind. (Server rendering from the static import is proven by
// the real SSR build in apps/web/config/injection-plugins.test.ts.)

const pageState = vi.hoisted(() => ({
  route: { id: '/(app)/projects/[projectId]' } as { id: string | null },
  params: { projectId: 'p1' } as Record<string, string>,
}))
vi.mock('$app/state', () => ({ page: pageState }))

const POINT = 'project.detail.before'
const entry = (id: string, order: number, component: unknown): InjectionEntry => ({
  id,
  order,
  component: component as InjectionEntry['component'],
})

const TWO = [entry('a', 10, TileA), entry('b', 20, TileB)]

function mount(props: Record<string, unknown>) {
  return render(PointHost, props)
}

const norm = (root: Element | null): string =>
  root === null
    ? 'missing'
    : serializeWithoutNoise(root).replace(/>\s+/g, '>').replace(/\s+</g, '<')

beforeEach(() => {
  pageState.route.id = '/(app)/projects/[projectId]'
  pageState.params = { projectId: 'p1' }
})

describe('InjectionPoint (rendered)', () => {
  it('renders contributions in the order given, with the route, params and entity reaching each, and no wrapper', () => {
    const { container } = mount({ entries: TWO, project: sampleProject() })
    const html = norm(container)
    expect(html.indexOf('id="a"')).toBeLessThan(html.indexOf('id="b"'))
    const a = container.querySelector('#a')
    expect(a?.getAttribute('data-route')).toBe('/(app)/projects/[projectId]')
    expect(a?.getAttribute('data-param')).toBe('p1')
    expect(a?.getAttribute('data-project')).toBe(sampleProject().name)
    // the only children of the host section are the contributions themselves: no wrapper element
    expect(container.querySelector('#host')?.children).toHaveLength(2)
    expect([...(container.querySelector('#host')?.children ?? [])].map((el) => el.tagName)).toEqual(
      ['P', 'P']
    )
  })

  it('falls back to an empty route id and no params on an unmatched route', () => {
    pageState.route.id = null
    pageState.params = {}
    const a = mount({ entries: TWO }).container.querySelector('#a')
    expect(a?.getAttribute('data-route')).toBe('')
    expect(a?.getAttribute('data-param')).toBe('')
  })

  it('renders the fallback only when there are no contributions (Q7)', () => {
    const fallbackOf = (props: Record<string, unknown>) =>
      mount(props).container.querySelector('#fallback')
    expect(fallbackOf({ entries: [], withFallback: true })).not.toBeNull()
    expect(fallbackOf({ withFallback: true })).not.toBeNull()
    expect(fallbackOf({ entries: TWO, withFallback: true })).toBeNull()
  })

  it('renders nothing at all with no contributions and no fallback', () => {
    const { container } = mount({ entries: [] })
    expect(norm(container.querySelector('#host'))).toBe('')
  })

  it('aligns data entry i to contribution i, null for a hole, a shorter array or missing data', () => {
    const text = (props: Record<string, unknown>) =>
      mount(props).container.textContent?.replace(/\s+/g, ' ')
    const holes = text({ entries: TWO, data: { [POINT]: [{ n: 1 }, null] } })
    expect(holes).toContain('A {"n":1}')
    expect(holes).toContain('B null')
    expect(text({ entries: TWO, data: { [POINT]: [{ n: 1 }] } })).toContain('B null')
    expect(text({ entries: TWO, data: {} })).toContain('A null')
    expect(text({ entries: TWO })).toContain('B null')
  })

  it('puts a contribution svelte:head content into the document head, once', () => {
    mount({ entries: [entry('h', 1, TileHead)] })
    expect(document.head.querySelectorAll('meta[name="x"]')).toHaveLength(1)
  })

  it('lets a contribution render error propagate: no catch, no boundary (invariant 0)', () => {
    expect(() => mount({ entries: [entry('t', 1, TileThrows)] })).toThrow(
      'contribution render failure'
    )
  })

  it('re-renders when the entity prop changes', async () => {
    const { rerender, container } = mount({ entries: TWO, project: null })
    expect(container.querySelector('#a')?.getAttribute('data-project')).toBe('')
    await rerender({ entries: TWO, project: sampleProject() })
    expect(container.querySelector('#a')?.getAttribute('data-project')).toBe(sampleProject().name)
  })

  it('shows the contribution data when the data prop changes (client navigation)', async () => {
    const { rerender, container } = mount({ entries: TWO, data: { [POINT]: [1, 2] } })
    expect(container.querySelector('#b')?.textContent).toBe('B 2')
    await rerender({ entries: TWO, data: { [POINT]: [1, 3] } })
    expect(container.querySelector('#b')?.textContent).toBe('B 3')
  })
})

describe('InjectionPoint source (AC-11: no boundary, no sanitizer, no wrapper)', () => {
  const FORBIDDEN = [
    'iframe',
    'srcdoc',
    'sandbox',
    'DOMPurify',
    '{@html',
    'attachShadow',
    'Content-Security-Policy',
    'console.',
  ]
  const files = import.meta.glob('./*.{svelte,ts}', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>

  it('scans the composition directory and finds the component', () => {
    expect(Object.keys(files)).toContain('./InjectionPoint.svelte')
  })

  it('contains none of the forbidden constructs', () => {
    for (const [file, text] of Object.entries(files)) {
      if (file.endsWith('.test.ts')) continue
      for (const token of FORBIDDEN) expect(text, `${file} contains ${token}`).not.toContain(token)
      expect(text, `${file} has a try block`).not.toMatch(/\btry\s*\{/)
    }
  })

  it('does not import the legacy panel sanitizer', () => {
    for (const [file, text] of Object.entries(files)) {
      if (!file.endsWith('.test.ts')) expect(text).not.toContain('render-panel-html')
    }
  })
})
