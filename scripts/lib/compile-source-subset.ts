// Compiles one TypeScript entry and the relative modules it reaches into a fresh temp directory.
// Tests that need a real ESM artifact (a worker thread, a spawned CLI) call this instead of keeping
// their own file list. The directory layout mirrors the sources, so a specifier such as
// `../fs-access.js` or `new URL('./worker.js', import.meta.url)` still resolves after emit.
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import {
  makeDirectory,
  makeTempDirectory,
  pathExists,
  readText,
  realPath,
  removeTree,
  writeText,
} from './fs-access.js'

const PREFIX = 'compileSourceSubset'
const JS_EXT = '.js'
const TS_EXT = '.ts'
const TEMP_PREFIX = 'pv-compile-subset-'
const MODULE_PACKAGE = '{"type":"module"}\n'
const TRANSPILE: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ES2022,
}

export interface CompiledSourceSubset {
  /** File URL of the compiled entry module. */
  entryUrl: string
  /** Temp directory that holds the emitted tree and `package.json`. */
  directory: string
  /** Deletes `directory`. A second call does nothing. */
  cleanup: () => void
}

export function compileSourceSubset(entryFile: string): CompiledSourceSubset {
  const entry = existingEntry(entryFile)
  const files = collectClosure(entry)
  const root = commonDirectory(files)
  const directory = makeTempDirectory(join(tmpdir(), TEMP_PREFIX))
  try {
    writeText(join(directory, 'package.json'), MODULE_PACKAGE)
    for (const file of files) emitOne(directory, root, file)
  } catch (error) {
    removeTree(directory)
    throw error
  }
  return {
    entryUrl: pathToFileURL(emittedPath(directory, root, entry)).href,
    directory,
    cleanup: () => removeTree(directory),
  }
}

function existingEntry(entryFile: string): string {
  if (!pathExists(entryFile)) {
    throw new Error(`${PREFIX}: entry file does not exist (${entryFile})`)
  }
  return outsideNodeModules(realPath(entryFile))
}

function collectClosure(entry: string): string[] {
  const files: string[] = []
  const seen = new Set<string>()
  const pending = [entry]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined || seen.has(current)) continue
    seen.add(current)
    files.push(current)
    for (const specifier of relativeSpecifiers(readText(current), current)) {
      const resolved = resolveRelative(current, specifier)
      if (resolved !== null) pending.push(resolved)
    }
  }
  return files
}

function relativeSpecifiers(sourceText: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS
  )
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    const specifier = specifierFrom(node)
    if (specifier !== undefined) found.push(specifier)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

function specifierFrom(node: ts.Node): string | undefined {
  if (ts.isImportDeclaration(node)) return valueImportSpecifier(node)
  if (ts.isExportDeclaration(node)) return valueExportSpecifier(node)
  if (ts.isCallExpression(node)) return dynamicImportSpecifier(node)
  if (ts.isNewExpression(node)) return newUrlSpecifier(node)
  return undefined
}

function valueImportSpecifier(node: ts.ImportDeclaration): string | undefined {
  if (node.importClause?.isTypeOnly === true) return undefined
  return stringSpecifier(node.moduleSpecifier)
}

function valueExportSpecifier(node: ts.ExportDeclaration): string | undefined {
  if (node.isTypeOnly || node.moduleSpecifier === undefined) return undefined
  return stringSpecifier(node.moduleSpecifier)
}

function dynamicImportSpecifier(node: ts.CallExpression): string | undefined {
  if (node.expression.kind !== ts.SyntaxKind.ImportKeyword) return undefined
  return stringSpecifier(node.arguments[0])
}

function newUrlSpecifier(node: ts.NewExpression): string | undefined {
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'URL') return undefined
  const args = node.arguments
  if (args === undefined) return undefined
  const spec = stringSpecifier(args[0])
  const base = args[1]
  if (spec === undefined || base === undefined || !isRelativeSpecifier(spec)) return undefined
  return isImportMetaUrl(base) ? spec : undefined
}

function isImportMetaUrl(node: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== 'url') return false
  const meta = node.expression
  return ts.isMetaProperty(meta) && meta.keywordToken === ts.SyntaxKind.ImportKeyword
}

function stringSpecifier(node: ts.Expression | undefined): string | undefined {
  return node !== undefined && ts.isStringLiteral(node) ? node.text : undefined
}

function resolveRelative(fromFile: string, specifier: string): string | null {
  if (!isRelativeSpecifier(specifier)) return null
  const base = join(dirname(fromFile), specifier)
  for (const candidate of sourceCandidates(base)) {
    if (pathExists(candidate)) return outsideNodeModules(realPath(candidate))
  }
  throw new Error(`${PREFIX}: ${fromFile} imports ${specifier}, and no source file resolves`)
}

function sourceCandidates(base: string): string[] {
  if (extname(base) !== JS_EXT) return [base]
  return [base, `${base.slice(0, -JS_EXT.length)}${TS_EXT}`]
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../')
}

function outsideNodeModules(file: string): string {
  if (file.split(sep).includes('node_modules')) {
    throw new Error(`${PREFIX}: refusing to compile a file inside node_modules (${file})`)
  }
  return file
}

function commonDirectory(files: readonly string[]): string {
  let prefix = files[0] ?? ''
  for (const file of files) {
    let index = 0
    const limit = Math.min(prefix.length, file.length)
    while (index < limit && prefix.charAt(index) === file.charAt(index)) index += 1
    prefix = prefix.slice(0, index)
  }
  const slash = prefix.lastIndexOf(sep)
  if (slash <= 0) throw new Error(`${PREFIX}: compiled files do not share a directory`)
  return prefix.slice(0, slash)
}

function emitOne(directory: string, root: string, file: string): void {
  const target = emittedPath(directory, root, file)
  makeDirectory(dirname(target))
  const compiled = ts.transpileModule(readText(file), {
    fileName: file,
    compilerOptions: TRANSPILE,
  })
  writeText(target, compiled.outputText)
}

function emittedPath(directory: string, root: string, file: string): string {
  const sourceName = extname(file) === TS_EXT ? `${file.slice(0, -TS_EXT.length)}${JS_EXT}` : file
  return join(directory, relative(root, sourceName))
}
