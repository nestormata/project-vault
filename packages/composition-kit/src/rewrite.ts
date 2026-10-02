import { extname } from 'node:path'
import type * as TypeScript from 'typescript'
import { requirePeer } from './peers.js'

/** One module specifier in a file: `start`..`end` are the offsets of the specifier text itself
 * (inside its quotes), so a replacement keeps the quotes and everything around it. */
export interface SpecifierSite {
  specifier: string
  start: number
  end: number
  /** True for CSS `@import` and `url()` references (never rewritten to an alias: CSS gets relative paths). */
  css?: boolean
}

export interface ScanResult {
  specifiers: SpecifierSite[]
  /** `new URL('./x', import.meta.url)` references: they cannot be rewritten safely. */
  importMetaUrlAssets: string[]
}

export interface Edit extends SpecifierSite {
  replacement: string
}

interface SvelteRoot {
  instance?: { content: { start: number; end: number } } | null
  module?: { content: { start: number; end: number } } | null
  css?: { content: { start: number; end: number } } | null
}

interface SvelteCompiler {
  parse(source: string, options: { modern: true }): SvelteRoot
}

const NON_LOCAL = /^(?:[a-z][a-z0-9+.-]*:|\/|#|\$)/i

function scriptKind(ts: typeof TypeScript, file: string): TypeScript.ScriptKind {
  const extension = extname(file)
  return extension === '.js' || extension === '.mjs' || extension === '.cjs'
    ? ts.ScriptKind.JS
    : ts.ScriptKind.TS
}

function literalSite(
  node: TypeScript.Node,
  offset: number,
  ts: typeof TypeScript
): SpecifierSite | null {
  if (!ts.isStringLiteralLike(node)) return null
  return {
    specifier: node.text,
    start: node.getStart() + 1 + offset,
    end: node.getEnd() - 1 + offset,
  }
}

function isImportMetaUrl(node: TypeScript.Node | undefined, ts: typeof TypeScript): boolean {
  return (
    node !== undefined &&
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'url' &&
    ts.isMetaProperty(node.expression)
  )
}

function scanScript(
  text: string,
  file: string,
  offset: number,
  resolveFrom: string,
  into: ScanResult
): void {
  const ts = requirePeer<typeof TypeScript>('typescript', resolveFrom)
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(ts, file))
  const visit = (node: TypeScript.Node): void => {
    const literal = specifierNode(node, ts)
    const site = literal === undefined ? null : literalSite(literal, offset, ts)
    if (site !== null) into.specifiers.push(site)
    const asset = importMetaUrlAsset(node, ts)
    if (asset !== undefined) into.importMetaUrlAssets.push(asset)
    ts.forEachChild(node, visit)
  }
  visit(source)
}

/** The string-literal node holding a module specifier, for every import form. */
function specifierNode(node: TypeScript.Node, ts: typeof TypeScript): TypeScript.Node | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    return node.moduleReference.expression
  }
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return node.arguments.at(0)
  }
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) return node.argument.literal
  return undefined
}

/** `new URL('./asset', import.meta.url)`: the literal, or undefined for any other node. */
function importMetaUrlAsset(node: TypeScript.Node, ts: typeof TypeScript): string | undefined {
  if (
    !ts.isNewExpression(node) ||
    !ts.isIdentifier(node.expression) ||
    node.expression.text !== 'URL'
  ) {
    return undefined
  }
  const [first, second] = node.arguments ?? []
  if (!isImportMetaUrl(second, ts) || first === undefined || !ts.isStringLiteralLike(first))
    return undefined
  return first.text
}

const CSS_QUOTES = new Set(['"', "'"])
const CSS_TERMINATORS = new Set([')', ';', ' ', '\t', '\n', '\r'])

/** Reads one CSS reference starting at `from` (after `@import` or `url(`): optional whitespace,
 * an optional `url(`, an optional quote, then the reference text. */
function readCssReference(
  text: string,
  from: number
): { value: string; start: number } | undefined {
  let at = from
  const skipSpace = (): void => {
    while (text.at(at) === ' ' || text.at(at) === '\t' || text.at(at) === '\n') at++
  }
  skipSpace()
  if (text.startsWith('url(', at)) {
    at += 'url('.length
    skipSpace()
  }
  const quote = CSS_QUOTES.has(text.at(at) ?? '') ? text.at(at) : undefined
  if (quote !== undefined) at++
  const start = at
  while (
    at < text.length &&
    (quote === undefined ? !CSS_TERMINATORS.has(text.at(at) ?? ';') : text.at(at) !== quote)
  )
    at++
  const value = text.slice(start, at)
  return value === '' ? undefined : { value, start }
}

function* cssMarkers(text: string): Generator<number> {
  for (const marker of ['@import', 'url(']) {
    for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + 1)) {
      // `@import url(...)` is read from the `@import` marker; the `url(` inside it is skipped.
      if (marker === 'url(' && /@import\s+$/.test(text.slice(Math.max(0, at - 16), at))) continue
      yield marker === '@import' ? at + marker.length : at + 'url('.length
    }
  }
}

function scanCss(text: string, offset: number, into: ScanResult): void {
  for (const from of cssMarkers(text)) {
    const reference = readCssReference(text, from)
    if (reference === undefined || NON_LOCAL.test(reference.value)) continue
    const start = offset + reference.start
    if (!into.specifiers.some((site) => site.start === start)) {
      into.specifiers.push({
        specifier: reference.value,
        start,
        end: start + reference.value.length,
        css: true,
      })
    }
  }
}

/** Every module specifier (and CSS reference) in a `.ts`/`.js`/`.mjs`/`.svelte`/`.css` file, in
 * source order. TypeScript and JavaScript are read with the app's own `typescript` AST, Svelte
 * script blocks through `svelte/compiler`, so strings, comments and template text never match. */
export function scanSpecifiers(text: string, file: string, resolveFrom: string): ScanResult {
  const result: ScanResult = { specifiers: [], importMetaUrlAssets: [] }
  const extension = extname(file)
  if (extension === '.css') {
    scanCss(text, 0, result)
  } else if (extension === '.svelte') {
    const compiler = requirePeer<SvelteCompiler>('svelte/compiler', resolveFrom)
    const root = compiler.parse(text, { modern: true })
    for (const script of [root.module, root.instance]) {
      if (script)
        scanScript(
          text.slice(script.content.start, script.content.end),
          `${file}.ts`,
          script.content.start,
          resolveFrom,
          result
        )
    }
    if (root.css)
      scanCss(
        text.slice(root.css.content.start, root.css.content.end),
        root.css.content.start,
        result
      )
  } else {
    scanScript(text, file, 0, resolveFrom, result)
  }
  result.specifiers.sort((a, b) => a.start - b.start)
  return result
}

/** Replaces each site's specifier text, whatever order the edits come in. */
export function applyEdits(text: string, edits: readonly Edit[]): string {
  let output = text
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    output = output.slice(0, edit.start) + edit.replacement + output.slice(edit.end)
  }
  return output
}
