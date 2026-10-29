// Story 72.7 (P3b): which entries sit in the bottom bar and which move into "More".
import { describe, expect, it } from 'vitest'
import type { NavNode } from '$lib/navigation/types.js'
import { buildBottomBarModel, legacyNavNodes } from './bottom-bar-model.js'

function node(id: string, extra: Partial<NavNode> = {}): NavNode {
  return {
    id,
    kind: 'link',
    label: id,
    mobileLabel: id,
    description: '',
    title: '',
    href: `/${id}` as NavNode['href'],
    query: '',
    active: false,
    current: false,
    shortcut: '',
    children: [],
    ...extra,
  }
}

describe('buildBottomBarModel', () => {
  it('shows the first four internal links and moves the rest into More, in nav order', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => node(id))
    const model = buildBottomBarModel(nodes)
    expect(model.bar.map((n) => n.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(model.more.map((n) => n.id)).toEqual(['e', 'f'])
    expect(model.moreCurrent).toBe(false)
  })

  it('puts actions and external links in More, never in the bar', () => {
    const search = node('search', { kind: 'action', href: undefined, onSelect: () => {} })
    const docs = node('docs', {
      kind: 'external',
      href: undefined,
      external: { scheme: 'https', rest: 'example.test/docs' },
    })
    const model = buildBottomBarModel([search, docs, node('a')])
    expect(model.bar.map((n) => n.id)).toEqual(['a'])
    expect(model.more.map((n) => n.id)).toEqual(['search', 'docs'])
  })

  it('flattens a section label and a disclosure so no item is hidden', () => {
    const section = node('reports', {
      kind: 'group',
      href: undefined,
      children: [node('daily'), node('weekly')],
    })
    const disclosure = node('tools', { children: [node('x'), node('y')] })
    const model = buildBottomBarModel([section, disclosure], 3)
    expect(model.bar.map((n) => n.id)).toEqual(['daily', 'weekly', 'tools'])
    expect(model.more.map((n) => n.id)).toEqual(['x', 'y'])
    expect(model.bar.every((n) => n.children.length === 0)).toBe(true)
  })

  it('marks More current when an overflowed entry is the current page', () => {
    const nodes = ['a', 'b', 'c', 'd'].map((id) => node(id))
    nodes.push(node('e', { active: true, current: true }))
    expect(buildBottomBarModel(nodes).moreCurrent).toBe(true)
  })

  it('an empty nav gives an empty model', () => {
    const model = buildBottomBarModel([])
    expect(model).toEqual({ bar: [], more: [], moreCurrent: false })
  })

  it('drops an empty group', () => {
    const empty = node('empty', { kind: 'group', href: undefined })
    expect(buildBottomBarModel([empty, node('a')]).bar.map((n) => n.id)).toEqual(['a'])
  })
})

describe('legacyNavNodes', () => {
  it('turns extension navItems into nodes with active state and children', () => {
    const nodes = legacyNavNodes(
      [
        {
          label: 'Tools',
          mobileLabel: 'Tools',
          href: '/ext/tools',
          children: [{ label: 'Sub', mobileLabel: 'Sub', href: '/ext/tools/sub' }],
        },
      ],
      '/ext/tools/sub'
    )
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.href).toBe('/ext/tools')
    expect(nodes[0]?.active).toBe(true)
    expect(nodes[0]?.children[0]?.active).toBe(true)
    expect(nodes[0]?.current).toBe(true)
  })
})
