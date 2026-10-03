// Story 68.7 AC-1/AC-2/AC-4/AC-6/AC-7/AC-14: `buildSurface` (PV's tree, the delta, then `when`)
// and `renderSurface` (labels, hrefs and active state evaluated for one render). Production renders
// are total (a bad op or a throwing CM callback costs that op or item only); dev throws with the id.
import { describe, expect, it } from 'vitest'
import { buildSurface, renderSurface } from './build-surface.js'
import type { NavContexts, NavDelta, NavNode } from './types.js'

const operator = { isPlatformOperator: true, orgRole: 'owner' }
const member = { isPlatformOperator: false, orgRole: 'member' }

const primaryCtx = (user = operator, pathname = '/projects/x'): NavContexts['primary'] => ({
  user,
  hasUiPanelExtension: true,
  pathname,
})

const ids = (nodes: readonly { id: string }[]) => nodes.map((node) => node.id)

function walk(nodes: readonly NavNode[]): NavNode[] {
  return nodes.flatMap((node) => [node, ...walk(node.children)])
}

describe('buildSurface (Story 68.7 AC-1)', () => {
  it('primary: nine items in main order for an operator with a ui-panel extension', () => {
    const built = buildSurface('primary', primaryCtx(), {})
    expect(ids(built.visible)).toEqual([
      'primary.search',
      'primary.dashboard',
      'primary.projects',
      'primary.secrets',
      'primary.notifications',
      'primary.health',
      'primary.settings',
      'primary.platform',
      'primary.extension-panel',
    ])
    expect(built.problems).toEqual([])
  })

  it('project: nine nodes in the full tree, eight visible for a viewer (no endpoints)', () => {
    const built = buildSurface(
      'project',
      { projectId: 'p1', orgRole: 'viewer', pathname: '/projects/p1' },
      {}
    )
    expect(built.items).toHaveLength(9)
    expect(ids(built.visible)).not.toContain('project.endpoints')
    expect(built.visible).toHaveLength(8)
  })

  it('allocates a fresh tree per call (no shared mutable state)', () => {
    const a = buildSurface('primary', primaryCtx(), {})
    const b = buildSurface('primary', primaryCtx(), {})
    expect(a.items).not.toBe(b.items)
    expect(a.items[0]).not.toBe(b.items[0])
  })
})

describe('renderSurface (Story 68.7 AC-2/AC-4/AC-7)', () => {
  it('evaluates labels, hrefs and active state; parents of an active item are `current`', () => {
    const delta: NavDelta = {
      primary: [
        {
          op: 'insert',
          parent: 'primary.settings',
          item: {
            id: 'cm.a',
            label: 'A',
            children: [
              {
                id: 'cm.b',
                label: 'B',
                children: [{ id: 'cm.c', label: () => 'C', href: () => '/projects/x' as never }],
              },
            ],
          },
        },
      ],
    }
    const nodes = renderSurface('primary', primaryCtx(), { delta, strict: true })
    const settings = nodes.find((node) => node.id === 'primary.settings')
    expect(settings?.current).toBe(true)
    expect(settings?.active).toBe(false)
    const deepest = walk(nodes).find((node) => node.id === 'cm.c')
    expect(deepest).toMatchObject({ label: 'C', href: '/projects/x', active: true, kind: 'link' })
    expect(walk(nodes).find((node) => node.id === 'cm.a')?.kind).toBe('group')
    expect(nodes.find((node) => node.id === 'primary.projects')?.active).toBe(true)
  })

  it('a CM item href reads the surface context (one item, two projects)', () => {
    const delta: NavDelta = {
      project: [
        {
          op: 'insert',
          parent: 'project',
          item: {
            id: 'cm.billing',
            label: 'Billing',
            href: (ctx) => `/projects/${ctx.projectId}/billing` as never,
          },
        },
      ],
    }
    for (const projectId of ['p1', 'p2']) {
      const nodes = renderSurface(
        'project',
        { projectId, orgRole: 'owner', pathname: '/' },
        { delta, strict: true }
      )
      expect(nodes.at(-1)?.href).toBe(`/projects/${projectId}/billing`)
    }
  })

  it('a plain-string relabel renders that string; a function relabel re-runs per render', () => {
    let locale = 'en'
    const delta: NavDelta = {
      primary: [
        {
          op: 'relabel',
          id: 'primary.health',
          label: () => (locale === 'en' ? 'Status' : 'Estado'),
        },
        { op: 'relabel', id: 'primary.secrets', label: 'Vault' },
      ],
    }
    const label = (id: string) =>
      renderSurface('primary', primaryCtx(), { delta, strict: true }).find((node) => node.id === id)
        ?.label
    expect(label('primary.health')).toBe('Status')
    locale = 'es'
    expect(label('primary.health')).toBe('Estado')
    expect(label('primary.secrets')).toBe('Vault')
  })

  it('a link href must be a same-origin path; an absolute URL needs kind external', () => {
    const bad = (href: string): NavDelta => ({
      primary: [
        {
          op: 'insert',
          parent: 'primary',
          item: { id: 'cm.x', label: 'X', href: () => href as never },
        },
      ],
    })
    for (const href of ['//evil.example/x', 'javascript:alert(1)', 'https://example.com']) {
      expect(() =>
        renderSurface('primary', primaryCtx(), { delta: bad(href), strict: true })
      ).toThrow(
        `nav item "cm.x": a link href must be a same-origin path (starting with one "/"); use kind "external" for an absolute URL, got ${JSON.stringify(href)}`
      )
      expect(
        ids(renderSurface('primary', primaryCtx(), { delta: bad(href), strict: false }))
      ).not.toContain('cm.x')
    }
    const external = renderSurface('primary', primaryCtx(), {
      delta: {
        primary: [
          {
            op: 'insert',
            parent: 'primary',
            item: {
              id: 'cm.docs',
              kind: 'external',
              label: 'Docs',
              href: () => 'https://docs.example/a?b=1',
            },
          },
        ],
      },
      strict: true,
    }).at(-1)
    expect(external?.external).toEqual({ scheme: 'https', rest: 'docs.example/a?b=1' })
    expect(external?.href).toBeUndefined()
  })

  it('a throwing CM callback omits that item in production and throws with its id in dev', () => {
    const delta: NavDelta = {
      primary: [
        {
          op: 'insert',
          parent: 'primary',
          item: {
            id: 'cm.boom',
            label: () => {
              throw new Error('label exploded')
            },
            href: () => '/x' as never,
          },
        },
      ],
    }
    expect(ids(renderSurface('primary', primaryCtx(), { delta, strict: false }))).not.toContain(
      'cm.boom'
    )
    expect(renderSurface('primary', primaryCtx(), { delta, strict: false })).toHaveLength(9)
    expect(() => renderSurface('primary', primaryCtx(), { delta, strict: true })).toThrow(
      'nav item "cm.boom": label exploded'
    )
  })

  it('an invalid op is skipped in production and throws with every problem in dev', () => {
    const delta: NavDelta = {
      primary: [
        { op: 'hide', id: 'primary.health' },
        { op: 'move', id: 'primary.nope', parent: 'primary' },
      ],
    }
    expect(ids(renderSurface('primary', primaryCtx(), { delta, strict: false }))).not.toContain(
      'primary.health'
    )
    expect(() => renderSurface('primary', primaryCtx(), { delta, strict: true })).toThrow(
      /nav delta problems in surface "primary":\n {2}- primary: op 2 \(move\) unknown nav id "primary.nope"/
    )
  })

  it('a string icon on a data item renders nothing (only components)', () => {
    const delta: NavDelta = {
      primary: [
        {
          op: 'insert',
          parent: 'primary',
          item: { id: 'cm.i', label: 'I', icon: 'puzzle-piece', href: () => '/i' as never },
        },
      ],
    }
    expect(
      renderSurface('primary', primaryCtx(), { delta, strict: true }).at(-1)?.icon
    ).toBeUndefined()
  })

  it('an action item calls its handler with the context', () => {
    let searched = 0
    const nodes = renderSurface(
      'primary',
      { ...primaryCtx(member), search: () => (searched += 1) },
      { delta: {}, strict: true }
    )
    void nodes[0]?.onSelect?.()
    expect(nodes[0]).toMatchObject({
      id: 'primary.search',
      kind: 'action',
      title: 'Search (⌘K)',
      shortcut: '⌘K',
    })
    expect(searched).toBe(1)
  })

  it('tab items carry their query and match by the context', () => {
    const nodes = renderSurface(
      'notifications.tabs',
      { pathname: '/notifications', status: 'unread' },
      { delta: {}, strict: true }
    )
    expect(nodes.map((node) => [node.query, node.active])).toEqual([
      ['?status=all', false],
      ['?status=unread', true],
      ['?status=read', false],
    ])
  })

  it('Overview matches exactly; other project tabs match the path prefix', () => {
    const active = (pathname: string) =>
      renderSurface(
        'project',
        { projectId: 'p1', orgRole: 'owner', pathname },
        { delta: {}, strict: true }
      )
        .filter((node) => node.active)
        .map((node) => node.id)
    expect(active('/projects/p1')).toEqual(['project.overview'])
    expect(active('/projects/p1/members/x')).toEqual(['project.members'])
  })
})

describe('cross-request isolation (Story 68.7 AC-14)', () => {
  it('50 interleaved renders for an operator and a member each see only their own items', async () => {
    const renders = Array.from({ length: 50 }, async (_, index) => {
      const user = index % 2 === 0 ? operator : member
      await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.floor(Math.random() * 5)))
      return {
        user,
        nodes: renderSurface('primary', primaryCtx(user), { delta: {}, strict: true }),
      }
    })
    for (const { user, nodes } of await Promise.all(renders)) {
      expect(ids(nodes).includes('primary.platform')).toBe(user.isPlatformOperator)
    }
  })
})
