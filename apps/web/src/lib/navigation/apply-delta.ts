// Story 68.7 AC-5/AC-6/AC-7 (ADR 0007 M5, design §7): applies a nav delta inside PV's nav model.
// The operations run in array order on a fresh copy of PV's FULL tree (anchors are stable regardless
// of who is looking), then PV's visibility conditions run (`visibleItems`). Pure and total: it never
// mutates its inputs, never throws, skips every invalid op and reports it as a problem. Every check
// is integrity only (an id exists, ids do not collide by accident, an op is well-formed); nothing
// here limits which items an op may change.
import { isNavId } from './nav-registry.js'
import type { NavItem, NavItemFields, NavKind } from './types.js'

/** A node of the delta-applied tree: `hidden` nodes stay as anchors but are never rendered. */
export interface TreeItem<C> extends NavItem<C> {
  hidden?: boolean
  children?: TreeItem<C>[]
}

export interface ApplyResult<C> {
  items: TreeItem<C>[]
  problems: string[]
  notes: string[]
}

export interface ApplyOptions {
  /** The surface that owns an id that is not in this tree (the Q4 message), if any. */
  ownerOf?: (id: string) => string | undefined
}

type Fields<C> = Omit<NavItemFields<C>, 'children'>

interface Node<C> {
  id: string
  fields: Fields<C>
  hidden: boolean
  children: Node<C>[] | undefined
  parent: Node<C> | null
}

type Rec = Record<string, unknown>

function isRecord(value: unknown): value is Rec {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** An own property only (never one inherited from a prototype, never `__proto__` magic). */
function own(record: Rec, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value
}

/** The kind an item renders as: explicit, else `action` (handler), `group` (only children), `link`. */
export function kindOf<C>(
  item: Pick<NavItemFields<C>, 'kind' | 'onSelect' | 'href' | 'children'>
): NavKind {
  if (item.kind !== undefined) return item.kind
  if (item.onSelect !== undefined) return 'action'
  return item.href === undefined && item.children !== undefined ? 'group' : 'link'
}

function fieldsOf<C>(item: NavItemFields<C>): Fields<C> {
  const { children: _children, ...fields } = item as NavItemFields<C> & { id?: string }
  const { id: _id, ...rest } = fields as Fields<C> & { id?: string }
  return rest
}

class Tree<C> {
  readonly root: Node<C>
  readonly byId = new Map<string, Node<C>>()

  constructor(surface: string, items: readonly NavItem<C>[]) {
    this.root = {
      id: surface,
      fields: { label: surface },
      hidden: false,
      children: [],
      parent: null,
    }
    this.byId.set(surface, this.root)
    this.root.children = items.map((item) => this.build(item, this.root))
  }

  build(item: NavItem<C>, parent: Node<C>): Node<C> {
    const node: Node<C> = {
      id: item.id,
      fields: fieldsOf(item),
      hidden: false,
      children: undefined,
      parent,
    }
    this.byId.set(item.id, node)
    if (item.children !== undefined)
      node.children = item.children.map((child) => this.build(child, node))
    return node
  }

  detach(node: Node<C>): void {
    const siblings = node.parent?.children ?? []
    siblings.splice(siblings.indexOf(node), 1)
    node.parent = null
  }

  forget(node: Node<C>): void {
    this.byId.delete(node.id)
    for (const child of node.children ?? []) this.forget(child)
  }

  /** Is `candidate` the node itself or inside its subtree? */
  within(candidate: Node<C> | null, node: Node<C>): boolean {
    for (let at = candidate; at !== null; at = at.parent) if (at === node) return true
    return false
  }

  attach(node: Node<C>, parent: Node<C>, index: number): void {
    parent.children ??= []
    parent.children.splice(index, 0, node)
    node.parent = parent
  }

  out(nodes: readonly Node<C>[]): TreeItem<C>[] {
    return nodes.map((node) => ({
      ...node.fields,
      id: node.id,
      ...(node.hidden ? { hidden: true } : {}),
      ...(node.children === undefined ? {} : { children: this.out(node.children) }),
    }))
  }
}

function subtreeIds<C>(nodes: readonly Node<C>[]): string[] {
  return nodes.flatMap((node) => [node.id, ...subtreeIds(node.children ?? [])])
}

interface Placement {
  key: 'after' | 'before' | 'parent'
  id: string
}

class Problem extends Error {}

/** One delta application: the tree, the findings and the message prefix of the current op. */
class Application<C> {
  readonly problems: string[] = []
  readonly notes: string[] = []
  prefix = ''
  /** Ids a `replace` with declared children is about to drop, so they may be declared again. */
  released: ReadonlySet<string> = new Set()

  constructor(
    readonly surface: string,
    readonly tree: Tree<C>,
    readonly options: ApplyOptions
  ) {}

  fail(message: string): never {
    throw new Problem(`${this.prefix} ${message}`)
  }

  unknown(id: string): never {
    const owner = this.options.ownerOf?.(id)
    if (owner !== undefined && owner !== this.surface) {
      this.fail(`nav id "${id}" belongs to surface "${owner}", not "${this.surface}"`)
    }
    this.fail(`unknown nav id "${id}"`)
  }

  node(id: unknown): Node<C> {
    if (typeof id !== 'string') this.fail('needs an id')
    const node = this.tree.byId.get(id)
    if (node === undefined || node === this.tree.root) this.unknown(id)
    return node
  }

  placement(op: Rec): Placement {
    const given = (['after', 'before', 'parent'] as const).filter(
      (key) => own(op, key) !== undefined
    )
    const key = given.length === 1 ? given[0] : undefined
    const id = key === undefined ? undefined : own(op, key)
    if (key === undefined || typeof id !== 'string') {
      this.fail('needs exactly one of after, before or parent')
    }
    return { key, id }
  }

  /** Where a placement lands: the new parent and the index in its children. */
  target(place: Placement): { parent: Node<C>; index: number; anchor: Node<C> } {
    const anchor = this.tree.byId.get(place.id)
    if (anchor === undefined) this.unknown(place.id)
    if (place.key === 'parent') {
      return { parent: anchor, index: anchor.children?.length ?? 0, anchor }
    }
    if (anchor === this.tree.root) this.fail(`"${place.id}" is the surface root; use parent`)
    const parent = anchor.parent ?? this.tree.root
    const index = (parent.children ?? []).indexOf(anchor) + (place.key === 'after' ? 1 : 0)
    return { parent, index, anchor }
  }

  acceptsChildren(parent: Node<C>): void {
    if (parent !== this.tree.root && kindOf(parent.fields) === 'action') {
      this.fail(`"${parent.id}" is an action item and cannot hold children`)
    }
  }

  checkItem(item: unknown, declaredIds: Set<string>, requireId: boolean): void {
    if (!isRecord(item)) this.fail('needs an item object')
    const id = own(item, 'id')
    if (requireId) this.checkNewId(id, declaredIds)
    const name = typeof id === 'string' ? id : 'the replacement'
    this.checkLabel(item, name)
    if (own(item, 'kind') === 'action' && typeof own(item, 'onSelect') !== 'function') {
      this.fail(`action item "${name}" needs an onSelect handler`)
    }
    const children = own(item, 'children') ?? []
    if (!Array.isArray(children)) this.fail(`item "${name}" children must be an array`)
    for (const child of children as unknown[]) this.checkItem(child, declaredIds, true)
  }

  /** Every item needs a label: it is the accessible name, also of an icon-only item. */
  checkLabel(item: Rec, name: string): void {
    const label = own(item, 'label')
    if (typeof label === 'string' || typeof label === 'function') return
    this.fail(
      own(item, 'icon') === undefined
        ? `item "${name}" needs a label`
        : `item "${name}" needs a label (an accessible name), even with an icon`
    )
  }

  checkNewId(id: unknown, declaredIds: Set<string>): void {
    if (typeof id !== 'string') this.fail('item needs an id')
    if (!isNavId(id)) this.fail(`nav id "${id}" breaks the id grammar`)
    if ((this.tree.byId.has(id) && !this.released.has(id)) || declaredIds.has(id)) {
      this.fail(`nav id "${id}" already exists; use replace to change it`)
    }
    declaredIds.add(id)
  }

  insert(op: Rec): void {
    const place = this.placement(op)
    this.checkItem(own(op, 'item'), new Set(), true)
    const { parent, index } = this.target(place)
    this.acceptsChildren(parent)
    this.tree.attach(this.tree.build(own(op, 'item') as NavItem<C>, parent), parent, index)
  }

  remove(op: Rec): void {
    const node = this.absentIsNote(op, 'remove')
    if (node === undefined) return
    this.tree.detach(node)
    this.tree.forget(node)
  }

  hide(op: Rec): void {
    const node = this.absentIsNote(op, 'hide')
    if (node !== undefined) node.hidden = true
  }

  /** `hide`/`remove` of an absent id: the desired state already holds (design §7). */
  absentIsNote(op: Rec, verb: string): Node<C> | undefined {
    const id = own(op, 'id')
    if (typeof id !== 'string') this.fail('needs an id')
    const node = this.tree.byId.get(id)
    if (node === undefined) {
      this.notes.push(`${this.prefix} nav id "${id}" does not exist; nothing to ${verb}`)
      return undefined
    }
    if (node === this.tree.root) this.fail(`"${id}" is the surface root`)
    return node
  }

  relabel(op: Rec): void {
    const node = this.node(own(op, 'id'))
    const label = own(op, 'label')
    if (typeof label === 'string' || typeof label === 'function') {
      node.fields = { ...node.fields, label: label as Fields<C>['label'] }
      return
    }
    const changes = isRecord(label)
      ? (['label', 'mobileLabel', 'description'] as const).filter(
          (key) => own(label, key) !== undefined
        )
      : []
    if (!isRecord(label) || changes.length === 0) this.fail('names no label to change')
    const next = { ...node.fields }
    for (const key of changes) Object.assign(next, { [key]: own(label, key) })
    node.fields = next
  }

  move(op: Rec): void {
    const node = this.node(own(op, 'id'))
    const place = this.placement(op)
    const { parent, anchor } = this.target(place)
    if (anchor === node || this.tree.within(parent, node)) {
      this.fail(`would move "${node.id}" into its own subtree`)
    }
    this.acceptsChildren(parent)
    this.tree.detach(node)
    const { index } = this.target(place)
    this.tree.attach(node, parent, index)
  }

  replace(op: Rec): void {
    const node = this.node(own(op, 'id'))
    const item = own(op, 'item')
    const itemId = isRecord(item) ? own(item, 'id') : undefined
    if (itemId !== undefined && itemId !== node.id) {
      const shown = typeof itemId === 'string' ? itemId : JSON.stringify(itemId)
      this.fail(`keeps the target id; item.id "${shown}" must be omitted`)
    }
    this.released = new Set(subtreeIds(node.children ?? []))
    try {
      this.checkItem(item, new Set(), false)
    } finally {
      this.released = new Set()
    }
    this.replaceWith(node, item as NavItemFields<C>)
  }

  /** Q5: the node keeps its id; PV's `when` and children stay unless the replacement declares its
   * own (so a replaced conditional item does not become visible to everyone by accident). */
  replaceWith(node: Node<C>, replacement: NavItemFields<C>): void {
    const keepWhen = !Object.hasOwn(replacement, 'when') && node.fields.when !== undefined
    node.fields = { ...fieldsOf(replacement), ...(keepWhen ? { when: node.fields.when } : {}) }
    if (!Object.hasOwn(replacement, 'children')) return
    for (const child of node.children ?? []) this.tree.forget(child)
    node.children = (replacement.children ?? []).map((child) => this.tree.build(child, node))
  }

  reorder(op: Rec): void {
    const parentId = own(op, 'parent')
    const parent = typeof parentId === 'string' ? this.tree.byId.get(parentId) : undefined
    if (parent === undefined) this.unknown(String(parentId))
    const ids = own(op, 'ids')
    if (!Array.isArray(ids)) this.fail('needs an ids array')
    const children = parent.children ?? []
    const seen = new Set<unknown>()
    for (const id of ids) {
      if (seen.has(id)) this.fail(`lists "${String(id)}" twice`)
      seen.add(id)
      if (!children.some((child) => child.id === id)) {
        this.fail(`"${String(id)}" is not a child of "${parent.id}"`)
      }
    }
    const listed = ids.map((id) => children.find((child) => child.id === id) as Node<C>)
    parent.children = [...listed, ...children.filter((child) => !seen.has(child.id))]
  }

  run(op: unknown, index: number): void {
    this.prefix = `${this.surface}: op ${index + 1}`
    if (!isRecord(op)) {
      this.problems.push(`${this.prefix} is not an object`)
      return
    }
    const name = own(op, 'op')
    const handler = typeof name === 'string' ? OPERATIONS.get(name) : undefined
    if (handler === undefined) {
      this.problems.push(`${this.prefix} has an unknown op "${String(name)}"`)
      return
    }
    this.prefix = `${this.prefix} (${String(name)})`
    try {
      handler.call(this as Application<unknown>, op)
    } catch (error) {
      if (!(error instanceof Problem)) throw error
      this.problems.push(error.message)
    }
  }
}

const OPERATIONS = new Map<string, (this: Application<unknown>, op: Rec) => void>([
  ['insert', Application.prototype.insert],
  ['remove', Application.prototype.remove],
  ['hide', Application.prototype.hide],
  ['relabel', Application.prototype.relabel],
  ['move', Application.prototype.move],
  ['replace', Application.prototype.replace],
  ['reorder', Application.prototype.reorder],
])

/** Applies `ops` (in order) to a fresh copy of PV's `items` for `surface`. An invalid op is skipped
 * and reported in `problems`; `hide`/`remove` of an absent id is a note. A failed op leaves the tree
 * exactly as it was before that op. */
export function applyNavDelta<C>(
  surface: string,
  items: readonly NavItem<C>[],
  ops: readonly unknown[],
  options: ApplyOptions = {}
): ApplyResult<C> {
  const application = new Application<C>(surface, new Tree(surface, items), options)
  ops.forEach((op, index) => application.run(op, index))
  return {
    items: application.tree.out(application.tree.root.children ?? []),
    problems: application.problems,
    notes: application.notes,
  }
}

function shown<C>(
  item: TreeItem<C>,
  ctx: C,
  onError?: (id: string, error: unknown) => void
): boolean {
  if (item.hidden === true) return false
  try {
    return item.when === undefined || item.when(ctx)
  } catch (error) {
    onError?.(item.id, error)
    return false
  }
}

/** PV's (and CM's) visibility conditions, after the delta: hidden nodes, items whose `when` is
 * false (or throws: reported through `onError`, that one item omitted) and groups left with no
 * visible children are dropped, subtree and all. */
export function visibleItems<C>(
  items: readonly TreeItem<C>[],
  ctx: C,
  onError?: (id: string, error: unknown) => void
): NavItem<C>[] {
  return items.flatMap((item) => {
    if (!shown(item, ctx, onError)) return []
    const { hidden: _hidden, children, ...rest } = item
    if (children === undefined) return [rest]
    const visible = visibleItems(children, ctx, onError)
    const emptyGroup = visible.length === 0 && rest.href === undefined && kindOf(item) !== 'action'
    return emptyGroup ? [] : [{ ...rest, children: visible }]
  })
}
