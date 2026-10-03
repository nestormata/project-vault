// Story 68.7 AC-9 (design §7 "Drift", Q8): reads a UI pack's `nav.ts` with the app's TypeScript and
// records every string-literal nav id its operations name, with the surface (the delta key the op
// sits under). Targets and anchors are operative, except the targets of `hide`/`remove`; the ids
// the pack inserts itself are `declared` (never host references). An id that is not a literal is
// a note with its position: compose time cannot check it, the shipped composed-nav test does. Every
// compose prints how many references were literal, so a delta built through helpers cannot hide
// that drift detection is blind. Integrity only: nothing here limits what a pack may change.
import type * as TypeScript from 'typescript'

export interface NavIdReference {
  id: string
  operative: boolean
  /** The delta key the operation sits under, or null when it is built outside the delta literal. */
  surface: string | null
  /** The operation, and whether the id is its target (`hide('x')`) or an anchor (`after: 'x'`). */
  op?: string
  role?: 'target' | 'anchor'
}

export interface NavDeclaredId {
  id: string
  surface: string | null
}

export interface NavReferences {
  references: NavIdReference[]
  declared: NavDeclaredId[]
  notes: string[]
  problems: string[]
}

const OPS = new Set(['insert', 'remove', 'hide', 'relabel', 'move', 'replace', 'reorder'])
const ANCHORS = ['after', 'before', 'parent'] as const

type TS = typeof TypeScript

class Reader {
  readonly out: NavReferences = { references: [], declared: [], notes: [], problems: [] }
  literal = 0
  unchecked = 0

  constructor(
    readonly ts: TS,
    readonly source: TypeScript.SourceFile,
    readonly file: string,
    readonly surfaces: ReadonlySet<string>
  ) {}

  where(node: TypeScript.Node): string {
    const { line, character } = this.source.getLineAndCharacterOfPosition(
      node.getStart(this.source)
    )
    return `${this.file}:${line + 1}:${character + 1}`
  }

  text(node: TypeScript.Node | undefined): string | undefined {
    if (node === undefined) return undefined
    const { ts } = this
    return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      ? node.text
      : undefined
  }

  /** Records one id-valued expression; `root` anchors (the surface itself) are not references. */
  id(
    node: TypeScript.Node | undefined,
    operative: boolean,
    surface: string | null,
    tag: Pick<NavIdReference, 'op' | 'role'> = {}
  ): void {
    if (node === undefined) return
    const value = this.text(node)
    if (value === undefined) {
      this.unchecked += 1
      this.out.notes.push(
        `nav id argument at ${this.where(node)} is not a string literal; the composed nav test checks it`
      )
      return
    }
    if (this.surfaces.has(value)) return
    this.literal += 1
    this.out.references.push({ id: value, operative, surface, ...tag })
  }

  property(object: TypeScript.Node | undefined, name: string): TypeScript.Expression | undefined {
    const { ts } = this
    if (object === undefined || !ts.isObjectLiteralExpression(object)) return undefined
    for (const member of object.properties) {
      if (ts.isPropertyAssignment(member) && this.keyOf(member.name) === name)
        return member.initializer
    }
    return undefined
  }

  keyOf(name: TypeScript.PropertyName): string | undefined {
    const { ts } = this
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text
    return undefined
  }

  anchors(spec: TypeScript.Node | undefined, surface: string | null, op: string): void {
    for (const key of ANCHORS)
      this.id(this.property(spec, key), true, surface, { op, role: 'anchor' })
  }

  /** The ids an inserted item (and its children, at any depth) declares. */
  declared(item: TypeScript.Node | undefined, surface: string | null): void {
    const { ts } = this
    if (item === undefined) return
    if (!ts.isObjectLiteralExpression(item)) {
      this.unchecked += 1
      this.out.notes.push(
        `${this.where(item)}: insert item is not an object literal; its ids are not statically checked (the composed nav test checks them)`
      )
      return
    }
    const id = this.text(this.property(item, 'id'))
    if (id !== undefined) {
      this.literal += 1
      this.out.declared.push({ id, surface })
    }
    const children = this.property(item, 'children')
    if (children !== undefined && ts.isArrayLiteralExpression(children)) {
      for (const child of children.elements) this.declared(child, surface)
    }
  }

  /** A builder call: `insert({...})`, `hide(id)`, `move(id, {...})`, `reorder(parent, ids)`, ... */
  call(op: string, args: readonly TypeScript.Expression[], surface: string | null): void {
    if (op === 'insert') {
      this.anchors(args[0], surface, op)
      this.declared(this.property(args[0], 'item'), surface)
    } else if (op === 'reorder') {
      this.id(args[0], true, surface, { op, role: 'anchor' })
      this.ids(args[1], surface)
    } else {
      this.id(args[0], op !== 'hide' && op !== 'remove', surface, { op, role: 'target' })
      if (op === 'move') this.anchors(args[1], surface, op)
    }
  }

  ids(list: TypeScript.Node | undefined, surface: string | null): void {
    const { ts } = this
    if (list === undefined) return
    if (!ts.isArrayLiteralExpression(list)) {
      this.id(list, true, surface, { op: 'reorder', role: 'target' })
      return
    }
    for (const element of list.elements)
      this.id(element, true, surface, { op: 'reorder', role: 'target' })
  }

  /** A plain operation object `{ op: 'hide', id: '...' }`. */
  object(op: string, node: TypeScript.ObjectLiteralExpression, surface: string | null): void {
    if (op === 'insert') {
      this.anchors(node, surface, op)
      this.declared(this.property(node, 'item'), surface)
    } else if (op === 'reorder') {
      this.id(this.property(node, 'parent'), true, surface, { op, role: 'anchor' })
      this.ids(this.property(node, 'ids'), surface)
    } else {
      this.id(this.property(node, 'id'), op !== 'hide' && op !== 'remove', surface, {
        op,
        role: 'target',
      })
      if (op === 'move') this.anchors(node, surface, op)
    }
  }

  /** The op name of a node that is an operation (builder call or op object), else undefined. */
  opOf(node: TypeScript.Node): string | undefined {
    const { ts } = this
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined
      return name !== undefined && OPS.has(name) ? name : undefined
    }
    if (ts.isObjectLiteralExpression(node)) {
      const op = this.text(this.property(node, 'op'))
      return op !== undefined && OPS.has(op) ? op : undefined
    }
    return undefined
  }

  /** The delta key an operation sits under (`primary: [ <op>, ... ]`). */
  surfaceOf(node: TypeScript.Node): string | null {
    const { ts } = this
    const array = node.parent
    if (array === undefined || !ts.isArrayLiteralExpression(array)) return null
    const assignment = array.parent
    if (assignment === undefined || !ts.isPropertyAssignment(assignment)) return null
    return this.keyOf(assignment.name) ?? null
  }

  visit(node: TypeScript.Node): void {
    const { ts } = this
    const op = this.opOf(node)
    if (op !== undefined) {
      const surface = this.surfaceOf(node)
      if (ts.isCallExpression(node)) this.call(op, node.arguments, surface)
      else this.object(op, node as TypeScript.ObjectLiteralExpression, surface)
    } else if (this.isDeltaElement(node)) {
      this.unchecked += 1
    }
    ts.forEachChild(node, (child) => this.visit(child))
  }

  /** A delta array element that is not an operation (a spread, a helper call, a variable). */
  isDeltaElement(node: TypeScript.Node): boolean {
    const { ts } = this
    const array = node.parent
    return (
      array !== undefined &&
      ts.isArrayLiteralExpression(array) &&
      array.parent !== undefined &&
      ts.isPropertyAssignment(array.parent) &&
      this.surfaces.has(this.keyOf(array.parent.name) ?? '')
    )
  }
}

function syntaxProblems(code: string, ts: TS, file: string): string[] {
  const { diagnostics } = ts.transpileModule(code, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  })
  return (diagnostics ?? []).map((diagnostic) => {
    const at =
      diagnostic.file === undefined || diagnostic.start === undefined
        ? { line: 0, character: 0 }
        : diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
    return `${file}:${at.line + 1}:${at.character + 1}: ${message}`
  })
}

/** Reads `code` (the pack's nav file at `file`). `surfaces` are the host's surface ids (a
 * `parent: '<surface>'` anchor is the surface root, not a reference). */
export function extractNavReferences(
  code: string,
  ts: TS,
  file: string,
  surfaces: readonly string[]
): NavReferences {
  const problems = syntaxProblems(code, ts, file)
  if (problems.length > 0) return { references: [], declared: [], notes: [], problems }
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true)
  const reader = new Reader(ts, source, file, new Set(surfaces))
  reader.visit(source)
  reader.out.notes.push(
    `nav references: ${reader.literal} literal, ${reader.unchecked} not statically checked`
  )
  return reader.out
}
