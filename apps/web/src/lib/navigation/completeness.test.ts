// Story 68.7 design rule 7 (Elicitation 3): the op set is complete. From any PV tree, CM can reach
// any target tree (any subset of PV's items, any new items, any nesting, any order) with the seven
// operations. 200 random PV trees and random targets, each reached by a simple planner's delta.
import { describe, expect, it } from 'vitest'
import { applyNavDelta, type TreeItem } from './apply-delta.js'
import type { NavItem, NavOp } from './types.js'

interface Shape {
  id: string
  children: Shape[]
}

/** A small deterministic PRNG (mulberry32), so a failure reproduces from its seed. */
function rng(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A random forest of the given ids (each id under a random earlier id or at the root). */
function randomForest(ids: readonly string[], random: () => number): Shape[] {
  const roots: Shape[] = []
  const placed: Shape[] = []
  for (const id of ids) {
    const node: Shape = { id, children: [] }
    const parent =
      placed.length === 0 || random() < 0.4
        ? undefined
        : placed[Math.floor(random() * placed.length)]
    ;(parent?.children ?? roots).push(node)
    placed.push(node)
  }
  return roots
}

function toItems(shapes: readonly Shape[]): NavItem<unknown>[] {
  return shapes.map((shape) => ({
    id: shape.id,
    label: shape.id,
    ...(shape.children.length > 0 ? { children: toItems(shape.children) } : {}),
  }))
}

function shapeOf(items: readonly TreeItem<unknown>[]): Shape[] {
  return items.map((item) => ({ id: item.id, children: shapeOf(item.children ?? []) }))
}

function walk(
  shapes: readonly Shape[],
  parent: string,
  visit: (shape: Shape, parent: string) => void
): void {
  for (const shape of shapes) {
    visit(shape, parent)
    walk(shape.children, shape.id, visit)
  }
}

/** The planner: lift every kept PV node to the root, remove the rest, then rebuild the target in
 * pre-order, appending each node to its target parent (moving PV nodes, inserting new ones). */
function plan(pv: readonly Shape[], target: readonly Shape[]): NavOp<unknown>[] {
  const pvIds = new Set<string>()
  walk(pv, 'root', (shape) => pvIds.add(shape.id))
  const kept = new Set<string>()
  walk(target, 'root', (shape) => {
    if (pvIds.has(shape.id)) kept.add(shape.id)
  })
  const ops: NavOp<unknown>[] = [...kept].map((id) => ({ op: 'move', id, parent: 'root' }))
  for (const id of pvIds) if (!kept.has(id)) ops.push({ op: 'remove', id })
  walk(target, 'root', (shape, parent) => {
    ops.push(
      kept.has(shape.id)
        ? { op: 'move', id: shape.id, parent }
        : { op: 'insert', parent, item: { id: shape.id, label: shape.id } }
    )
  })
  return ops
}

describe('the delta op set is complete (Story 68.7 design rule 7)', () => {
  it('reaches 200 random target trees from 200 random PV trees', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const random = rng(seed)
      const pvIds = Array.from({ length: 3 + Math.floor(random() * 12) }, (_, i) => `pv.n${i}`)
      const pv = randomForest(pvIds, random)
      const keptIds = pvIds.filter(() => random() < 0.7)
      const newIds = Array.from({ length: Math.floor(random() * 6) }, (_, i) => `cm.n${i}`)
      const targetIds = [...keptIds, ...newIds].sort(() => random() - 0.5)
      const target = randomForest(targetIds, random)
      const result = applyNavDelta('root', toItems(pv), plan(pv, target))
      expect(result.problems, `seed ${seed}`).toEqual([])
      expect(shapeOf(result.items), `seed ${seed}`).toEqual(target)
    }
  })
})
