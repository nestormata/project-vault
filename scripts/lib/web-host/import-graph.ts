// Story 68.2 AC-2/AC-4/AC-7: the import graph of the web-host package, computed with real parsers
// (the TypeScript compiler API for .ts/.js, the Svelte compiler for .svelte script blocks), never
// with a regex over source text. It answers three questions for the pack script:
//   1. which bare packages the shipped app source needs at runtime (its `dependencies`);
//   2. which @project-vault/shared files the app reaches (what gets vendored);
//   3. whether shipped source imports a test file (a packaging error).
// Type-only imports (`import type`, `export type`) are skipped: they vanish at compile time and
// never need a runtime dependency. File text is read through `ts.sys`, the compiler's own host.
import { builtinModules, createRequire } from 'node:module'
import { dirname, extname, join, relative, sep } from 'node:path'
import ts from 'typescript'

const requireFromWeb = createRequire(
  join(import.meta.dirname, '..', '..', '..', 'apps/web/package.json')
)
const svelteCompiler = requireFromWeb('svelte/compiler') as typeof import('svelte/compiler')

/** A test file by name. Test-support modules (`src/lib/test/**`, `*-test-helpers.ts`) are not. */
export const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]s$/
const TEST_DIR_RE = /(^|\/)__tests__\//

export function isTestFile(path: string): boolean {
  return TEST_FILE_RE.test(path) || TEST_DIR_RE.test(path)
}

/** Test-support modules: shipped (they are tracked non-test source) but only imported by tests, so
 * they are not graph roots. The same categories apps/web's coverage config excludes. */
export function isTestSupportFile(path: string): boolean {
  return /(^|\/)src\/lib\/test\//.test(path) || /-test-helpers\.[cm]?[jt]s$/.test(path)
}

export interface ModuleSpecifier {
  specifier: string
  typeOnly: boolean
}

function scriptKindFor(fileName: string): ts.ScriptKind {
  return extname(fileName) === '.js' ? ts.ScriptKind.JS : ts.ScriptKind.TS
}

function specifierText(node: ts.Expression | undefined): string | undefined {
  return node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined
}

function collectFromScript(code: string, fileName: string): ModuleSpecifier[] {
  const source = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(fileName)
  )
  const found: ModuleSpecifier[] = []
  const visit = (node: ts.Node): void => {
    // `typeof import('x')` in a type position is type-only by definition: nothing to follow.
    if (ts.isImportTypeNode(node)) return
    const entry = specifierOf(node)
    if (entry !== undefined) found.push(entry)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** The module specifier a single node imports, re-exports or dynamically loads, if any. */
function specifierOf(node: ts.Node): ModuleSpecifier | undefined {
  let specifier: string | undefined
  let typeOnly = false
  if (ts.isImportDeclaration(node)) {
    specifier = specifierText(node.moduleSpecifier)
    typeOnly = node.importClause?.isTypeOnly ?? false
  } else if (ts.isExportDeclaration(node)) {
    specifier = specifierText(node.moduleSpecifier)
    typeOnly = node.isTypeOnly
  } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    specifier = specifierText(node.arguments[0])
  }
  return specifier === undefined ? undefined : { specifier, typeOnly }
}

interface SvelteScriptBlock {
  start: number
  end: number
}

/** The `<script>` and `<script module>` contents of a Svelte component. */
function svelteScripts(code: string, fileName: string): string[] {
  const ast = svelteCompiler.parse(code, { modern: true, filename: fileName }) as unknown as {
    instance?: { content: SvelteScriptBlock } | null
    module?: { content: SvelteScriptBlock } | null
  }
  return [ast.instance, ast.module].flatMap((script) =>
    script ? [code.slice(script.content.start, script.content.end)] : []
  )
}

/** Every module specifier a source file imports or re-exports, with its type-only flag. */
export function moduleSpecifiers(code: string, fileName: string): ModuleSpecifier[] {
  if (fileName.endsWith('.svelte')) {
    return svelteScripts(code, fileName).flatMap((script) =>
      collectFromScript(script, `${fileName}.ts`)
    )
  }
  return collectFromScript(code, fileName)
}

const BUILTINS = new Set(builtinModules)

/** The npm package a bare specifier names (`zod/v4` -> `zod`, `@a/b/c` -> `@a/b`), or undefined
 * for relative, absolute, Node built-in, SvelteKit (`$app`, `$lib`, `$env`) and virtual specifiers. */
export function packageNameOf(specifier: string): string | undefined {
  if (/^[./]/.test(specifier) || specifier.startsWith('$') || specifier.includes(':')) {
    return undefined
  }
  const parts = specifier.split('/')
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? '')
  return BUILTINS.has(name) ? undefined : name
}

/** How the graph turns an import specifier into a file. */
export interface GraphResolver {
  /** Absolute path for a specifier the app aliases (`$lib/...`, `@project-vault/shared`), else undefined. */
  alias: (specifier: string) => string | undefined
  /** Reads a file, or undefined when it does not exist. */
  readFile: (path: string) => string | undefined
}

export const sysReadFile = (path: string): string | undefined => ts.sys.readFile(path)

const CANDIDATE_SUFFIXES = ['', '.ts', '.js', '.svelte', '/index.ts', '/index.js']

function resolveFile(base: string, resolver: GraphResolver): string | undefined {
  const withoutJs = base.endsWith('.js') ? base.slice(0, -3) : undefined
  const candidates = [
    ...CANDIDATE_SUFFIXES.map((suffix) => `${base}${suffix}`),
    ...(withoutJs === undefined ? [] : [`${withoutJs}.ts`]),
  ]
  return candidates.find((candidate) => resolver.readFile(candidate) !== undefined)
}

export interface GraphResult {
  /** Every file reached, absolute. */
  files: Set<string>
  /** package name -> every file (absolute) that imports it at runtime. */
  bareImports: Map<string, string[]>
  /** Packaging errors: unresolvable relative imports, shipped source importing a test file. */
  errors: string[]
}

/** Walks runtime imports from `roots`. `display` turns an absolute path into a readable one. */
export function walkImportGraph(
  roots: string[],
  resolver: GraphResolver,
  display: (path: string) => string = (path) => path
): GraphResult {
  const result: GraphResult = { files: new Set(), bareImports: new Map(), errors: [] }
  const queue = [...roots]
  const record = (file: string, specifier: string): void => {
    const target = resolveSpecifier(specifier, file, resolver)
    if (target.kind === 'package') {
      result.bareImports.set(target.name, [...(result.bareImports.get(target.name) ?? []), file])
    } else if (target.kind === 'missing') {
      result.errors.push(`${display(file)}: cannot resolve ${JSON.stringify(specifier)}`)
    } else if (target.kind === 'file' && isTestFile(target.path)) {
      result.errors.push(`${display(file)} imports the test file ${display(target.path)}`)
    } else if (target.kind === 'file') {
      queue.push(target.path)
    }
  }
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (result.files.has(file)) continue
    result.files.add(file)
    const code = resolver.readFile(file)
    if (code === undefined) {
      result.errors.push(`${display(file)}: file not found`)
      continue
    }
    for (const { specifier, typeOnly } of moduleSpecifiers(code, file)) {
      if (!typeOnly) record(file, specifier)
    }
  }
  return result
}

/** A Vite query suffix (`./x.svg?raw`) names the same file. A linear scan, not a regex: a
 * `/\?.*$/` tries every `?` as a start and re-scans to the end, quadratic on `?`-heavy input. */
export function withoutQuery(specifier: string): string {
  const query = specifier.indexOf('?')
  return query === -1 ? specifier : specifier.slice(0, query)
}

type Resolved =
  | { kind: 'package'; name: string }
  | { kind: 'file'; path: string }
  | { kind: 'external' }
  | { kind: 'missing' }

function resolveSpecifier(specifier: string, importer: string, resolver: GraphResolver): Resolved {
  const path = withoutQuery(specifier)
  const aliased = resolver.alias(path)
  const base = aliased ?? (path.startsWith('.') ? join(dirname(importer), path) : undefined)
  if (base !== undefined) {
    const file = resolveFile(base, resolver)
    return file === undefined ? { kind: 'missing' } : { kind: 'file', path: file }
  }
  const name = packageNameOf(specifier)
  return name === undefined ? { kind: 'external' } : { kind: 'package', name }
}

/** `path` relative to `root`, with forward slashes. */
export function relativePosix(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

/** Orders strings by UTF-16 code unit, like a comparator-less `sort()`, but explicitly: the pack's
 * file lists must not depend on the build machine's locale or ICU data. */
export function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}
