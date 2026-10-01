import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type * as TypeScript from 'typescript'
import semver from 'semver'

// Story 66-6: `typescript` is a CommonJS package without a "type" field, so an ESM `import`
// makes Node syntax-scan the 9 MB typescript.js to detect its module format (~135 ms of the
// child's ~940 ms CPU profile). `require` loads it as CommonJS directly.
const ts: typeof TypeScript = createRequire(import.meta.url)('typescript')

const SNAPSHOT_NAME = 'api-surface.snapshot.md'

type SinceIndex = Map<string, string>

const EXPORT_PATTERN = /^## export `([^`]+)`$/
const MEMBER_PATTERN = /^(\s*)- member: `([^`]+)`$/
const INDEX_PATTERN = /^(\s*)- index-signature: `([^`]+)`$/
const SINCE_PATTERN = /^\s*- since: (\d+\.\d+\.\d+)$/
const SINCE_VALUE_PATTERN = /^- since: (\d+\.\d+\.\d+)/

function popNestedMembers(members: Array<{ indent: number; name: string }>, indent: number): void {
  while (true) {
    const last = members.at(-1)
    if (!last || last.indent < indent) break
    members.pop()
  }
}

function canonicalMemberName(name: string): string {
  return name.replace(/^readonly /, '')
}

// eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- parser walks nested snapshot entries
function snapshotSinceIndex(snapshot: string): SinceIndex {
  const index: SinceIndex = new Map()
  let exportName = ''
  const members: Array<{ indent: number; name: string }> = []
  let pendingKey: string | undefined

  for (const line of snapshot.split('\n')) {
    const exportMatch = EXPORT_PATTERN.exec(line)
    if (exportMatch) {
      const name = exportMatch[1]
      if (!name) continue
      exportName = name
      members.length = 0
      pendingKey = `export:${exportName}`
      continue
    }

    const memberMatch = MEMBER_PATTERN.exec(line)
    if (memberMatch) {
      const whitespace = memberMatch[1]
      const name = memberMatch[2]
      if (whitespace === undefined || name === undefined) continue
      const indent = whitespace.length
      popNestedMembers(members, indent)
      members.push({ indent, name })
      pendingKey = `export:${exportName}|${members.map((member) => canonicalMemberName(member.name)).join('|')}`
      continue
    }

    const indexMatch = INDEX_PATTERN.exec(line)
    if (indexMatch) {
      const whitespace = indexMatch[1]
      const name = indexMatch[2]
      if (whitespace === undefined || name === undefined) continue
      const indent = whitespace.length
      popNestedMembers(members, indent)
      members.push({ indent, name: `index:${name}` })
      pendingKey = `export:${exportName}|${members.map((member) => canonicalMemberName(member.name)).join('|')}`
      continue
    }

    const sinceMatch = SINCE_PATTERN.exec(line)
    const since = sinceMatch?.[1]
    if (since && pendingKey) index.set(pendingKey, since)
  }

  return index
}

export function applySinceAnnotations(
  generated: string,
  previous: string,
  currentVersion: string
): string {
  const previousIndex = snapshotSinceIndex(previous)
  let exportName = ''
  const members: Array<{ indent: number; name: string }> = []
  let pendingKey: string | undefined

  return (
    generated
      .split('\n')
      // eslint-disable-next-line complexity -- parser walks nested snapshot entries
      .map((line) => {
        const exportMatch = EXPORT_PATTERN.exec(line)
        if (exportMatch) {
          const name = exportMatch[1]
          if (!name) return line
          exportName = name
          members.length = 0
          pendingKey = `export:${exportName}`
          return line
        }

        const memberMatch = MEMBER_PATTERN.exec(line)
        if (memberMatch) {
          const whitespace = memberMatch[1]
          const name = memberMatch[2]
          if (whitespace === undefined || name === undefined) return line
          const indent = whitespace.length
          popNestedMembers(members, indent)
          members.push({ indent, name })
          pendingKey = `export:${exportName}|${members.map((member) => canonicalMemberName(member.name)).join('|')}`
          return line
        }

        const indexMatch = INDEX_PATTERN.exec(line)
        if (indexMatch) {
          const whitespace = indexMatch[1]
          const name = indexMatch[2]
          if (whitespace === undefined || name === undefined) return line
          const indent = whitespace.length
          popNestedMembers(members, indent)
          members.push({ indent, name: `index:${name}` })
          pendingKey = `export:${exportName}|${members.map((member) => canonicalMemberName(member.name)).join('|')}`
          return line
        }

        if (/^\s*- since: \d+\.\d+\.\d+$/.test(line) && pendingKey) {
          const since = previousIndex.get(pendingKey) ?? currentVersion
          const marker = '- since: '
          const markerStart = line.indexOf(marker)
          return markerStart === -1 ? line : `${line.slice(0, markerStart + marker.length)}${since}`
        }

        return line
      })
      .join('\n')
  )
}

/** The target's default lib without DOM/ScriptHost: lib.es2022.full.d.ts -> lib.es2022.d.ts. */
function ecmaScriptLib(options: TypeScript.CompilerOptions): string {
  const full = ts.getDefaultLibFileName(options)
  return full === 'lib.d.ts' ? 'lib.es5.d.ts' : full.replace(/\.full\.d\.ts$/, '.d.ts')
}

function compiler(root: string): {
  program: TypeScript.Program
  checker: TypeScript.TypeChecker
  source: TypeScript.SourceFile
} {
  const config = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile)
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  const sourcePath = join(root, 'src/index.ts')
  // Story 66-6: `types: []` skips the ~83 ambient @types/node files (259 -> 130 files) and the
  // ECMAScript-only default lib skips lib.dom.d.ts, the largest lib file (child CPU 1.3 s ->
  // 0.9 s). Output stays byte-identical because the public surface must not depend on Node or
  // DOM globals. The diagnostics guard (assertNoSourceDiagnostics, run by
  // generateSurfaceSnapshot after rendering) makes that fail closed instead of rendering an
  // unresolved type.
  const program = ts.createProgram(
    [sourcePath],
    {
      ...parsed.options,
      noEmit: true,
      types: [],
      lib: parsed.options.lib ?? [ecmaScriptLib(parsed.options)],
    },
    undefined
  )
  const source = program.getSourceFile(sourcePath)
  if (!source) throw new Error('could not load extension-api src/index.ts')
  return { program, checker: program.getTypeChecker(), source }
}

function assertNoSourceDiagnostics(program: TypeScript.Program, sourceDir: string): void {
  const prefix = `${sourceDir.replaceAll('\\', '/').replace(/\/$/, '')}/`
  const messages = program
    .getSourceFiles()
    .filter((file) => file.fileName.startsWith(prefix))
    .flatMap((file) => program.getSemanticDiagnostics(file))
    .map((diagnostic) => {
      const where = diagnostic.file?.fileName.slice(prefix.length - 'src/'.length) ?? '(global)'
      return `${where}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`
    })
  if (messages.length > 0)
    throw new Error(
      `public surface sources do not type-check without @types (types: []):\n${messages.join('\n')}`
    )
}

function typeText(
  checker: TypeScript.TypeChecker,
  type: TypeScript.Type,
  source: TypeScript.Node
): string {
  return checker.typeToString(
    type,
    source,
    ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope
  )
}

// eslint-disable-next-line complexity -- renders properties, index signatures, and nested members
function renderTypeMembers(
  checker: TypeScript.TypeChecker,
  type: TypeScript.Type,
  source: TypeScript.Node,
  indent: string,
  seen: Set<number>
): string[] {
  if (
    (type.flags & ts.TypeFlags.Object) === 0 ||
    checker.isArrayType(type) ||
    checker.isTupleType(type)
  )
    return []
  const lines: string[] = []
  for (const property of checker
    .getPropertiesOfType(type)
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? source
    const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration)
    const optional = (property.flags & ts.SymbolFlags.Optional) !== 0 ? '?' : ''
    const readonly =
      (ts.getCombinedModifierFlags(declaration as TypeScript.Declaration) &
        ts.ModifierFlags.Readonly) !==
      0
        ? 'readonly '
        : ''
    lines.push(
      `${indent}- member: \`${readonly}${property.name}${optional}\``,
      `${indent}  - since: 1.0.0`,
      ...renderType(checker, propertyType, declaration, `${indent}  `, seen)
    )
  }
  for (const index of checker.getIndexInfosOfType(type)) {
    const readonly = index.isReadonly ? 'readonly ' : ''
    const keyType = typeText(checker, index.keyType, source)
    const valueType = typeText(checker, index.type, source)
    lines.push(
      `${indent}- index-signature: \`${readonly}[${keyType}]: ${valueType}\``,
      `${indent}  - since: 1.0.0`
    )
  }
  return lines
}

function renderSignatures(
  checker: TypeScript.TypeChecker,
  type: TypeScript.Type,
  source: TypeScript.Node,
  indent: string
): string[] {
  return checker
    .getSignaturesOfType(type, ts.SignatureKind.Call)
    .map(
      (signature) =>
        `${indent}- call-signature: \`${checker.signatureToString(signature, source, ts.TypeFormatFlags.NoTruncation)}\``
    )
}

function renderType(
  checker: TypeScript.TypeChecker,
  type: TypeScript.Type,
  source: TypeScript.Node,
  indent: string,
  seen: Set<number>
): string[] {
  const lines = [`${indent}- type: \`${typeText(checker, type, source)}\``]
  if (type.isUnion()) {
    const members = type.types
      .map((member) => typeText(checker, member, source))
      .map((member) => `\`${member}\``)
      .join(', ')
    lines.push(`${indent}- union-members: ${members}`)
  }
  if (type.isIntersection()) {
    const members = type.types
      .map((member) => typeText(checker, member, source))
      .map((member) => `\`${member}\``)
      .join(', ')
    lines.push(`${indent}- intersection-members: ${members}`)
  }
  const id = (type as TypeScript.Type & { id?: number }).id
  if (id !== undefined && seen.has(id)) return lines
  if (id !== undefined) seen.add(id)
  lines.push(
    ...renderTypeMembers(checker, type, source, indent, seen),
    ...renderSignatures(checker, type, source, indent)
  )
  return lines
}

export function generateSurfaceSnapshot(root: string): string {
  const { program, checker, source } = compiler(root)
  const moduleSymbol = checker.getSymbolAtLocation(source)
  if (!moduleSymbol) throw new Error('could not resolve index.ts module symbol')
  const lines = [
    '# @project-vault/extension-api public type surface',
    '',
    'Generated from `src/index.ts`; update this file and classify the change against the policy when the contract changes.',
    '',
  ]
  for (const symbol of checker
    .getExportsOfModule(moduleSymbol)
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
    const declaration = target.valueDeclaration ?? target.declarations?.[0] ?? source
    const type =
      target.flags & ts.SymbolFlags.Type
        ? checker.getDeclaredTypeOfSymbol(target)
        : checker.getTypeOfSymbolAtLocation(target, declaration)
    lines.push(
      `## export \`${symbol.name}\``,
      '',
      '- since: 1.0.0',
      `- kind: ${target.flags & ts.SymbolFlags.Type ? 'type' : 'value'}`,
      ...renderType(checker, type, declaration, '', new Set()),
      ''
    )
  }
  // Only after rendering: a full check first creates checker symbols in a different order and
  // shifts the `__@match@<id>` ids in the output (DW-310), breaking byte-identity.
  assertNoSourceDiagnostics(program, join(root, 'src'))
  const generated = `${lines.join('\n').trimEnd()}\n`
  const previous = existsSync(join(root, SNAPSHOT_NAME))
    ? readFileSync(join(root, SNAPSHOT_NAME), 'utf8')
    : ''
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    version: string
  }
  return applySinceAnnotations(generated, previous, packageJson.version)
}

function validateExportSince(line: string, next: string, currentVersion: string): string[] {
  const since = SINCE_VALUE_PATTERN.exec(next)?.[1]
  if (!since) return [`${line} is missing since`]
  // Story 23.11 finding: a naive per-component comparison (comparing minor/patch positions
  // independently) false-positives across a MAJOR bump — e.g. `since: 2.2.0` was incorrectly
  // flagged as "exceeding" a new `3.0.0` current version purely because 2 > 0 at the minor
  // position, even though 2.2.0 is a genuinely earlier version than 3.0.0. Real semver
  // precedence (semver.gt) is the only correct comparison here.
  return semver.gt(since, currentVersion)
    ? [`${line} since ${since} exceeds ${currentVersion}`]
    : []
}

function validateMemberSince(line: string, next: string): string[] {
  return SINCE_VALUE_PATTERN.exec(next.trim()) ? [] : [`${line} is missing since`]
}

export function validateSinceIndex(snapshot: string, currentVersion = '2.0.0'): string[] {
  const lines = snapshot.split('\n')
  const errors: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const next = lines.slice(index + 1).find((candidate) => candidate.trim().length > 0) ?? ''
    if (line.startsWith('## export '))
      errors.push(...validateExportSince(line, next, currentVersion))
    const trimmed = line.trimStart()
    if (trimmed.startsWith('- member: ')) errors.push(...validateMemberSince(line, next))
    if (trimmed.startsWith('- index-signature: ')) errors.push(...validateMemberSince(line, next))
  }
  return errors
}

const CONTRACT_CHANGED =
  'public contract changed: update api-surface.snapshot.md and classify the change against AC-2'
const REGENERATE_HINT =
  'regenerate with `pnpm tsx tests/api-surface.ts --write` from packages/extension-api (CONTRIBUTING.md), then classify the change'
const MAX_DIFF_LINES = 20

// Story 66-6 AC-7: show the first differing lines (unified-diff style, `-` committed, `+`
// generated) so a CI log alone explains the mismatch; never dump the full ~97 KB snapshot.
function firstDifferingLines(committed: string, generated: string): string[] {
  const before = committed.split('\n')
  const after = generated.split('\n')
  const diff: string[] = []
  let hidden = 0
  for (let index = 0; index < Math.max(before.length, after.length); index += 1) {
    const left = before.at(index)
    const right = after.at(index)
    if (left === right) continue
    const pair = [left, right].flatMap((line, side) =>
      line === undefined ? [] : [`${side === 0 ? '-' : '+'} ${line}`]
    )
    if (diff.length + pair.length > MAX_DIFF_LINES) {
      hidden += pair.length
      continue
    }
    diff.push(`@@ line ${index + 1} @@`, ...pair)
  }
  return hidden > 0 ? [...diff, `… ${hidden} more differing lines not shown`] : diff
}

/**
 * Compares a generated surface against the committed `api-surface.snapshot.md`.
 *
 * Story 66-6: the caller passes the generated snapshot in. The test path produces it once in an
 * uninstrumented child process (tests/surface-runner.ts); this function reads the committed file
 * itself and does the comparison, so a child that prints nothing or "ok" can never pass.
 */
export function assertSurfaceSnapshotIsFresh(
  root: string,
  generated: string
): { ok: true } | { ok: false; errors: string[] } {
  const snapshot = readFileSync(join(root, SNAPSHOT_NAME), 'utf8')
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    version: string
  }
  const errors = validateSinceIndex(snapshot, packageJson.version)
  if (errors.length > 0) return { ok: false, errors }
  return generated === snapshot
    ? { ok: true }
    : {
        ok: false,
        errors: [CONTRACT_CHANGED, REGENERATE_HINT, ...firstDifferingLines(snapshot, generated)],
      }
}

interface CliStream {
  write(chunk: string): boolean
}

/**
 * `--emit` writes the generated snapshot to stdout (used by the surface runner's child process);
 * `--write` regenerates the committed snapshot in place (CONTRIBUTING.md).
 */
export function runSurfaceCli(
  argv: readonly string[],
  root: string,
  io: { stdout: CliStream; stderr: CliStream } = process
): number {
  if (argv.includes('--emit')) {
    try {
      io.stdout.write(generateSurfaceSnapshot(root))
      return 0
    } catch (error) {
      io.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
      )
      return 1
    }
  }
  if (argv.includes('--write')) {
    writeFileSync(join(root, SNAPSHOT_NAME), generateSurfaceSnapshot(root))
    return 0
  }
  io.stderr.write('usage: tsx tests/api-surface.ts --emit | --write\n')
  return 2
}

const entryPoint = process.argv[1]
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  process.exitCode = runSurfaceCli(process.argv, process.cwd())
}
