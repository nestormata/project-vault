// Story 68.7 AC-5/AC-6/AC-7 and design rule 7: the seven delta operations, applied in array order to
// a fresh copy of PV's full tree, then PV's visibility conditions. Pure: nothing is mutated, nothing
// throws, every invalid op becomes a problem and is skipped.
import { describe, expect, it, vi } from 'vitest'
import { applyNavDelta, visibleItems, type TreeItem } from './apply-delta.js'
import type { NavItem, NavOp } from './types.js'

interface Ctx {
  operator: boolean
  role: string
}

const label = (text: string) => () => text

function pv(): NavItem<Ctx>[] {
  return [
    { id: 'primary.dashboard', label: label('Dashboard') },
    { id: 'primary.projects', label: label('Projects') },
    { id: 'primary.secrets', label: label('Secrets') },
    { id: 'primary.health', label: label('Health') },
    { id: 'primary.settings', label: label('Settings') },
    { id: 'primary.platform', label: label('Platform'), when: (ctx) => ctx.operator },
  ]
}

const ids = (items: readonly NavItem<Ctx>[]): string[] => items.map((item) => item.id)

function tree(items: readonly TreeItem<Ctx>[]): unknown[] {
  return items.map((item) => ({
    id: item.id,
    ...(item.hidden === true ? { hidden: true } : {}),
    ...(item.children === undefined ? {} : { children: tree(item.children) }),
  }))
}

function apply(ops: readonly NavOp<Ctx>[], items = pv()) {
  return applyNavDelta('primary', items, ops)
}

const cm = (id: string, extra: Partial<NavItem<Ctx>> = {}): NavItem<Ctx> => ({
  id,
  label: label(id),
  ...extra,
})

describe('insert (Story 68.7 AC-5)', () => {
  it('after an anchor', () => {
    const result = apply([{ op: 'insert', after: 'primary.projects', item: cm('cm.billing') }])
    expect(result.problems).toEqual([])
    expect(ids(result.items).slice(0, 4)).toEqual([
      'primary.dashboard',
      'primary.projects',
      'cm.billing',
      'primary.secrets',
    ])
  })
  it('before an anchor, as the last child of a parent, and at the root', () => {
    const result = apply([
      { op: 'insert', before: 'primary.dashboard', item: cm('cm.first') },
      { op: 'insert', parent: 'primary.settings', item: cm('cm.child') },
      { op: 'insert', parent: 'primary', item: cm('cm.last') },
    ])
    expect(result.problems).toEqual([])
    expect(ids(result.items)[0]).toBe('cm.first')
    expect(ids(result.items).at(-1)).toBe('cm.last')
    expect(
      tree(result.items).find((item) => (item as { id: string }).id === 'primary.settings')
    ).toEqual({ id: 'primary.settings', children: [{ id: 'cm.child' }] })
  })
  it('needs exactly one anchor', () => {
    const none = apply([{ op: 'insert', item: cm('cm.a') }])
    const two = apply([
      { op: 'insert', after: 'primary.health', before: 'primary.health', item: cm('cm.b') },
    ])
    expect(none.problems).toEqual([
      'primary: op 1 (insert) needs exactly one of after, before or parent',
    ])
    expect(two.problems).toEqual([
      'primary: op 1 (insert) needs exactly one of after, before or parent',
    ])
    expect(ids(none.items)).toEqual(ids(pv()))
  })
  it('refuses an id that already exists (PV or an earlier insert): use replace', () => {
    const result = apply([
      { op: 'insert', parent: 'primary', item: cm('primary.health') },
      { op: 'insert', parent: 'primary', item: cm('cm.x') },
      { op: 'insert', parent: 'primary', item: cm('cm.x') },
    ])
    expect(result.problems).toEqual([
      'primary: op 1 (insert) nav id "primary.health" already exists; use replace to change it',
      'primary: op 3 (insert) nav id "cm.x" already exists; use replace to change it',
    ])
  })
  it('is valid after a hidden anchor and a problem after a removed one', () => {
    const hidden = apply([
      { op: 'hide', id: 'primary.health' },
      { op: 'insert', after: 'primary.health', item: cm('cm.a') },
    ])
    expect(hidden.problems).toEqual([])
    expect(ids(hidden.items)).toContain('cm.a')
    const removed = apply([
      { op: 'remove', id: 'primary.health' },
      { op: 'insert', after: 'primary.health', item: cm('cm.a') },
    ])
    expect(removed.problems).toEqual(['primary: op 2 (insert) unknown nav id "primary.health"'])
  })
})

describe('remove and hide', () => {
  it('remove drops the node and its subtree; an absent id is a note', () => {
    const result = apply([
      { op: 'insert', parent: 'primary.health', item: cm('cm.child') },
      { op: 'remove', id: 'primary.health' },
      { op: 'remove', id: 'primary.nope' },
    ])
    expect(result.problems).toEqual([])
    expect(ids(result.items)).not.toContain('primary.health')
    expect(result.notes).toEqual([
      'primary: op 3 (remove) nav id "primary.nope" does not exist; nothing to remove',
    ])
  })
  it('hide keeps the node as an anchor but not rendered; idempotent; absent id is a note', () => {
    const result = apply([
      { op: 'hide', id: 'settings.index.sso-domains' as never },
      { op: 'hide', id: 'primary.health' },
      { op: 'hide', id: 'primary.health' },
    ])
    expect(result.problems).toEqual([])
    expect(result.notes).toEqual([
      'primary: op 1 (hide) nav id "settings.index.sso-domains" does not exist; nothing to hide',
    ])
    expect(tree(result.items)).toContainEqual({ id: 'primary.health', hidden: true })
    expect(ids(visibleItems<Ctx>(result.items, { operator: true, role: 'owner' }))).not.toContain(
      'primary.health'
    )
  })
})

describe('relabel', () => {
  it('replaces only the named label functions', () => {
    const result = apply([
      { op: 'relabel', id: 'primary.secrets', label: () => 'Vault' },
      {
        op: 'relabel',
        id: 'primary.settings',
        label: { description: () => 'Seats and roles', mobileLabel: 'Set.' },
      },
    ])
    expect(result.problems).toEqual([])
    const secrets = result.items.find((item) => item.id === 'primary.secrets')
    const settings = result.items.find((item) => item.id === 'primary.settings')
    const ctx = { operator: false, role: 'owner' }
    expect(typeof secrets?.label === 'function' && secrets.label(ctx)).toBe('Vault')
    expect(typeof settings?.label === 'function' && settings.label(ctx)).toBe('Settings')
    expect(settings?.mobileLabel).toBe('Set.')
  })
  it('an empty object and an absent id are problems', () => {
    expect(
      apply([
        { op: 'relabel', id: 'primary.secrets', label: {} },
        { op: 'relabel', id: 'primary.nope', label: () => 'x' },
      ]).problems
    ).toEqual([
      'primary: op 1 (relabel) names no label to change',
      'primary: op 2 (relabel) unknown nav id "primary.nope"',
    ])
  })
})

describe('move', () => {
  it('nests a PV item under a CM group, subtree and all', () => {
    const result = apply([
      { op: 'insert', parent: 'primary', item: cm('cm.ops', { children: [] }) },
      { op: 'insert', parent: 'primary.health', item: cm('cm.deep') },
      { op: 'move', id: 'primary.health', parent: 'cm.ops' },
    ])
    expect(result.problems).toEqual([])
    expect(tree(result.items).at(-1)).toEqual({
      id: 'cm.ops',
      children: [{ id: 'primary.health', children: [{ id: 'cm.deep' }] }],
    })
  })
  it('refuses a move into its own descendant (cycle) and under an action item', () => {
    const result = apply([
      { op: 'insert', parent: 'primary.settings', item: cm('cm.child') },
      { op: 'move', id: 'primary.settings', parent: 'cm.child' },
      { op: 'move', id: 'primary.settings', after: 'primary.settings' },
      { op: 'insert', parent: 'primary', item: cm('cm.act', { onSelect: () => undefined }) },
      { op: 'move', id: 'primary.health', parent: 'cm.act' },
    ])
    expect(result.problems).toEqual([
      'primary: op 2 (move) would move "primary.settings" into its own subtree',
      'primary: op 3 (move) would move "primary.settings" into its own subtree',
      'primary: op 5 (move) "cm.act" is an action item and cannot hold children',
    ])
  })
  it('order-sensitive pair: reorder then move vs move then reorder', () => {
    const reorderThenMove = apply([
      { op: 'reorder', parent: 'primary', ids: ['primary.dashboard'] },
      { op: 'move', id: 'primary.dashboard', after: 'primary.settings' },
    ])
    const moveThenReorder = apply([
      { op: 'move', id: 'primary.dashboard', after: 'primary.settings' },
      { op: 'reorder', parent: 'primary', ids: ['primary.dashboard'] },
    ])
    expect(ids(reorderThenMove.items)).toEqual([
      'primary.projects',
      'primary.secrets',
      'primary.health',
      'primary.settings',
      'primary.dashboard',
      'primary.platform',
    ])
    expect(ids(moveThenReorder.items)).toEqual(ids(pv()))
  })
})

describe('replace', () => {
  it('keeps the id, PV children unless declared, and PV `when` unless declared', () => {
    const items = pv()
    items[4] = { ...cm('primary.settings'), children: [cm('primary.settings.a')] }
    const result = apply(
      [
        { op: 'replace', id: 'primary.settings', item: { label: () => 'Prefs' } },
        { op: 'replace', id: 'primary.platform', item: { label: () => 'Ops' } },
      ],
      items
    )
    expect(result.problems).toEqual([])
    expect(tree(result.items)).toContainEqual({
      id: 'primary.settings',
      children: [{ id: 'primary.settings.a' }],
    })
    expect(ids(visibleItems<Ctx>(result.items, { operator: false, role: 'owner' }))).not.toContain(
      'primary.platform'
    )
    const declared = apply(
      [{ op: 'replace', id: 'primary.settings', item: { label: () => 'P', children: [] } }],
      items
    )
    expect(tree(declared.items)).toContainEqual({ id: 'primary.settings', children: [] })
  })
  it('a different item id is a problem', () => {
    expect(
      apply([
        { op: 'replace', id: 'primary.health', item: { id: 'cm.h', label: () => 'H' } as never },
      ]).problems
    ).toEqual(['primary: op 1 (replace) keeps the target id; item.id "cm.h" must be omitted'])
  })
})

describe('reorder', () => {
  it('puts the listed ids first; unlisted children keep their relative order after them', () => {
    const result = apply([
      { op: 'reorder', parent: 'primary', ids: ['primary.projects', 'primary.dashboard'] },
    ])
    expect(ids(result.items)).toEqual([
      'primary.projects',
      'primary.dashboard',
      'primary.secrets',
      'primary.health',
      'primary.settings',
      'primary.platform',
    ])
  })
  it('a non-child or a duplicate is a problem; an empty list is a no-op', () => {
    const result = apply([
      { op: 'reorder', parent: 'primary', ids: ['primary.nope'] },
      { op: 'reorder', parent: 'primary', ids: ['primary.health', 'primary.health'] },
      { op: 'reorder', parent: 'primary', ids: [] },
    ])
    expect(result.problems).toEqual([
      'primary: op 1 (reorder) "primary.nope" is not a child of "primary"',
      'primary: op 2 (reorder) lists "primary.health" twice',
    ])
    expect(ids(result.items)).toEqual(ids(pv()))
  })
})

describe('shape and integrity problems (Story 68.7 AC-7)', () => {
  it('reports unknown ops, malformed ids, missing labels and actions without handlers', () => {
    const result = applyNavDelta('primary', pv(), [
      { op: 'teleport', id: 'primary.health' },
      null,
      { op: 'insert', parent: 'primary', item: { id: 'Bad Id', label: () => 'x' } },
      { op: 'insert', parent: 'primary', item: { id: 'cm.icon', icon: 'x' } },
      { op: 'insert', parent: 'primary', item: { id: 'cm.act', label: () => 'A', kind: 'action' } },
      { op: 'remove' },
    ] as never)
    expect(result.problems).toEqual([
      'primary: op 1 has an unknown op "teleport"',
      'primary: op 2 is not an object',
      'primary: op 3 (insert) nav id "Bad Id" breaks the id grammar',
      'primary: op 4 (insert) item "cm.icon" needs a label (an accessible name), even with an icon',
      'primary: op 5 (insert) action item "cm.act" needs an onSelect handler',
      'primary: op 6 (remove) needs an id',
    ])
  })
  it('names the owning surface when an id belongs elsewhere (Q4)', () => {
    const result = applyNavDelta(
      'primary',
      pv(),
      [{ op: 'relabel', id: 'project.members', label: 'M' }],
      { ownerOf: (id) => (id === 'project.members' ? 'project' : undefined) }
    )
    expect(result.problems).toEqual([
      'primary: op 1 (relabel) nav id "project.members" belongs to surface "project", not "primary"',
    ])
  })
})

describe('determinism, purity and inheritance (Story 68.7 AC-5/AC-6)', () => {
  const delta: NavOp<Ctx>[] = [
    { op: 'insert', after: 'primary.platform', item: cm('cm.after-platform') },
    { op: 'move', id: 'primary.health', parent: 'primary.settings' },
    { op: 'relabel', id: 'primary.dashboard', label: 'Home' },
  ]

  it('never mutates PV items or the delta; frozen inputs do not throw', () => {
    const items = deepFreeze(pv())
    const ops = deepFreeze(structuredCloneOps(delta))
    const first = applyNavDelta('primary', items, ops)
    const second = applyNavDelta('primary', items, ops)
    expect(tree(first.items)).toEqual(tree(second.items))
    expect(ids(items)).toEqual(ids(pv()))
  })

  it('anchors resolve against the full tree: an insert after an operator-only item', () => {
    const result = apply(delta)
    expect(ids(visibleItems<Ctx>(result.items, { operator: false, role: 'owner' })).at(-1)).toBe(
      'cm.after-platform'
    )
    const operator = ids(visibleItems<Ctx>(result.items, { operator: true, role: 'owner' }))
    expect(operator.slice(-2)).toEqual(['primary.platform', 'cm.after-platform'])
  })

  it('a new PV item is inherited with no delta change, also under reorder and replace', () => {
    const withNew = [...pv(), cm('primary.audit')]
    withNew[4] = { ...cm('primary.settings'), children: [cm('primary.settings.new')] }
    const result = apply(
      [
        { op: 'relabel', id: 'primary.health', label: 'Status' },
        { op: 'reorder', parent: 'primary', ids: ['primary.settings'] },
        { op: 'replace', id: 'primary.settings', item: { label: () => 'Prefs' } },
      ],
      withNew
    )
    expect(ids(result.items)).toEqual([
      'primary.settings',
      'primary.dashboard',
      'primary.projects',
      'primary.secrets',
      'primary.health',
      'primary.platform',
      'primary.audit',
    ])
    expect(tree(result.items)[0]).toEqual({
      id: 'primary.settings',
      children: [{ id: 'primary.settings.new' }],
    })
  })

  it('a CM child of an operator-only item, or of a hidden group, stays invisible', () => {
    const result = apply([
      { op: 'insert', parent: 'primary.platform', item: cm('cm.ops-only') },
      { op: 'insert', parent: 'primary', item: cm('cm.group', { children: [cm('cm.leaf')] }) },
      { op: 'hide', id: 'cm.group' },
    ])
    const visible = visibleItems<Ctx>(result.items, { operator: false, role: 'owner' })
    expect(JSON.stringify(tree(visible))).not.toContain('cm.ops-only')
    expect(JSON.stringify(tree(visible))).not.toContain('cm.leaf')
  })

  it('a moved PV item keeps its own `when`; a CM item may carry its own', () => {
    const result = apply([
      { op: 'insert', parent: 'primary', item: cm('cm.group', { children: [] }) },
      { op: 'move', id: 'primary.platform', parent: 'cm.group' },
      {
        op: 'insert',
        parent: 'primary',
        item: cm('cm.owners', { when: (ctx) => ctx.role === 'owner' }),
      },
    ])
    const member = visibleItems<Ctx>(result.items, { operator: false, role: 'member' })
    expect(ids(member)).not.toContain('cm.group')
    expect(ids(member)).not.toContain('cm.owners')
    const owner = visibleItems<Ctx>(result.items, { operator: true, role: 'owner' })
    expect(tree(owner)).toContainEqual({
      id: 'cm.group',
      children: [{ id: 'primary.platform' }],
    })
    expect(ids(owner)).toContain('cm.owners')
  })

  it('an empty group (no href, no action, nothing visible) is not rendered', () => {
    const result = apply([
      { op: 'insert', parent: 'primary', item: cm('cm.empty', { children: [cm('cm.x')] }) },
      { op: 'hide', id: 'cm.x' },
    ])
    expect(ids(visibleItems<Ctx>(result.items, { operator: true, role: 'owner' }))).not.toContain(
      'cm.empty'
    )
  })

  it('a `when` that throws hides that one item and reports it through onError', () => {
    const errors: string[] = []
    const result = apply([
      {
        op: 'insert',
        parent: 'primary',
        item: cm('cm.boom', {
          when: () => {
            throw new Error('nope')
          },
        }),
      },
    ])
    const visible = visibleItems<Ctx>(
      result.items,
      { operator: true, role: 'owner' },
      (id, error) => errors.push(`${id}: ${(error as Error).message}`)
    )
    expect(ids(visible)).not.toContain('cm.boom')
    expect(errors).toEqual(['cm.boom: nope'])
  })
})

describe('arbitrary nesting and scale', () => {
  it('keeps a 6-level tree unchanged (no depth cap)', () => {
    let deepest: NavItem<Ctx> = cm('cm.l6')
    for (let level = 5; level >= 1; level -= 1)
      deepest = cm(`cm.l${level}`, { children: [deepest] })
    const result = apply([{ op: 'insert', parent: 'primary.settings', item: deepest }])
    let node = result.items.find((item) => item.id === 'primary.settings')
    const path: string[] = []
    while (node?.children?.[0] !== undefined) {
      node = node.children[0]
      path.push(node.id)
    }
    expect(path).toEqual(['cm.l1', 'cm.l2', 'cm.l3', 'cm.l4', 'cm.l5', 'cm.l6'])
  })

  it('applies 200 ops to a 1 000-item tree with constant relinking work per op (no cap on the delta)', () => {
    const items = Array.from({ length: 1000 }, (_, index) => cm(`pv.i${index}`))
    const ops: NavOp<Ctx>[] = Array.from({ length: 200 }, (_, index) =>
      index % 2 === 0
        ? { op: 'move', id: `pv.i${index}`, parent: `pv.i${index + 500}` }
        : { op: 'insert', after: `pv.i${index * 3}`, item: cm(`cm.n${index}`) }
    )
    // Story 66-17: bounded work is counted, not timed. Each op relinks a constant number of nodes
    // (a move detaches then attaches: two splices; an insert attaches: one), so 100 moves and
    // 100 inserts take exactly 300 splices however large the tree is.
    const splice = vi.spyOn(Array.prototype, 'splice')
    let result: ReturnType<typeof applyNavDelta<Ctx>>
    let splices: number
    try {
      result = applyNavDelta('pv', items, ops)
      splices = splice.mock.calls.length
    } finally {
      splice.mockRestore()
    }
    expect(result.problems).toEqual([])
    expect(splices).toBe(300)
    // Every op applied: 1 000 original items, 100 inserted, the moved ones still present.
    const count = (nodes: readonly NavItem<Ctx>[]): number =>
      nodes.reduce((total, node) => total + 1 + count(node.children ?? []), 0)
    expect(count(result.items)).toBe(1100)
  })
})

function structuredCloneOps(ops: NavOp<Ctx>[]): NavOp<Ctx>[] {
  return ops.map((op) => ({ ...op }))
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
