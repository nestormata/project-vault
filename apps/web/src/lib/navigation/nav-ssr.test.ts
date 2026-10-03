// @vitest-environment node
// Story 68.7 AC-14 (SSR = client): every nav renderer's server render, with Svelte's hydration
// comments removed, is the same markup as its client render (the nav render oracle, recorded from a
// client mount), so hydration finds exactly the DOM it expects. Attribute order is compared as a
// set: the server writes attributes in source order, the client sets dynamic ones after static ones.
import { render } from 'svelte/server'
import { createRawSnippet } from 'svelte'
import { parse } from 'svelte/compiler'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pageState = vi.hoisted(() => ({
  page: {
    status: 200,
    error: null as { message: string } | null,
    data: {} as Record<string, unknown>,
    params: {},
    url: new URL('http://localhost/projects/p1'),
    route: { id: null },
    form: null,
    state: {},
  },
}))
vi.mock('$app/state', () => ({ page: pageState.page }))
vi.mock('$app/navigation', () => ({ goto: vi.fn() }))
vi.mock('$lib/api/auth.js', () => ({ logout: vi.fn() }))

import Footer from '$lib/components/shell/Footer.svelte'
import NotificationsLink from '$lib/components/shell/NotificationsLink.svelte'
import PrimaryNav from '$lib/components/shell/PrimaryNav.svelte'
import ProjectNav from '$lib/components/shell/ProjectNav.svelte'
import ShellAccount from '$lib/components/shell/ShellAccount.svelte'
import ShellBrand from '$lib/components/shell/ShellBrand.svelte'
import PlatformSettingsBreadcrumb from '$lib/components/platform/PlatformSettingsBreadcrumb.svelte'
import { testAuthUser } from '$lib/test/page-data.js'

const ORACLE = JSON.parse(
  readFileSync(join(import.meta.dirname, 'nav-render-oracle.snapshot.json'), 'utf8')
) as Record<string, string>

const body = createRawSnippet(() => ({ render: () => '<p data-child>body</p>' }))

interface MarkupNode {
  type: string
  name?: string
  data?: string
  attributes?: { name: string; value: true | { data?: string }[] }[]
  fragment?: { nodes: MarkupNode[] }
}

function attributeText(attribute: { name: string; value: true | { data?: string }[] }): string {
  if (attribute.value === true) return `${attribute.name}=""`
  return `${attribute.name}="${attribute.value.map((part) => part.data ?? '').join('')}"`
}

/** Serializes parsed markup: comments dropped, attributes sorted, text as written. */
function serialize(nodes: readonly MarkupNode[]): string {
  return nodes
    .map((node) => {
      if (node.type === 'Text') return node.data ?? ''
      if (node.type !== 'RegularElement') return ''
      const attributes = [...(node.attributes ?? [])]
        .map(attributeText)
        .sort((a, b) => (a < b ? -1 : 1))
      const open = [node.name ?? '', ...attributes].join(' ')
      return `<${open}>${serialize(node.fragment?.nodes ?? [])}</${node.name ?? ''}>`
    })
    .join('')
}

/** Markup parsed (Svelte's own HTML parser, no DOM needed in this environment) and re-serialized
 * with comments removed, attributes sorted and whitespace collapsed. */
function canonical(html: string): string {
  const ast = parse(html, { modern: true }) as unknown as { fragment: { nodes: MarkupNode[] } }
  return serialize(ast.fragment.nodes).replace(/\s+/g, ' ').trim()
}

function ssr(component: unknown, props: Record<string, unknown>): string {
  return canonical(render(component as never, { props } as never).body)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
})

describe('server render = client render for every nav renderer (Story 68.7 AC-14)', () => {
  it.each([
    [
      'PrimaryNav /projects/p1 operator=true panel=true',
      PrimaryNav,
      { isPlatformOperator: true, hasUiPanelExtension: true },
    ],
    ['PrimaryNav /projects/p1 operator=false panel=false', PrimaryNav, {}],
    [
      'ProjectNav /projects/p1 role=viewer archived=true',
      ProjectNav,
      { projectId: 'p1', orgRole: 'viewer', isArchived: true },
    ],
    [
      'ProjectNav /projects/p1 role=owner archived=false',
      ProjectNav,
      { projectId: 'p1', orgRole: 'owner' },
    ],
    ['ShellBrand hide=false', ShellBrand, {}],
    ['ShellBrand hide=true', ShellBrand, { hidePrimaryNav: true }],
    ['NotificationsLink 150', NotificationsLink, { unreadCount: 150 }],
    ['ShellAccount', ShellAccount, { user: testAuthUser({ orgRole: 'admin' }) }],
    ['Footer', Footer, {}],
    [
      'PlatformSettingsBreadcrumb',
      PlatformSettingsBreadcrumb,
      { allowed: true, leafLabel: 'Organizations', children: body },
    ],
  ])('%s', (key, component, props) => {
    pageState.page.url = new URL(
      `http://localhost${key.includes('/projects/p1') ? '/projects/p1' : '/platform/audit'}`
    )
    const expected = new Map(Object.entries(ORACLE)).get(key)
    expect(expected, key).toBeDefined()
    expect(ssr(component, props)).toBe(canonical(expected ?? ''))
  })
})
