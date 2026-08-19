import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

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

function compiler(root: string): {
  program: ts.Program
  checker: ts.TypeChecker
  source: ts.SourceFile
} {
  const config = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile)
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  const sourcePath = join(root, 'src/index.ts')
  const program = ts.createProgram([sourcePath], { ...parsed.options, noEmit: true }, undefined)
  const source = program.getSourceFile(sourcePath)
  if (!source) throw new Error('could not load extension-api src/index.ts')
  return { program, checker: program.getTypeChecker(), source }
}

function typeText(checker: ts.TypeChecker, type: ts.Type, source: ts.Node): string {
  return checker.typeToString(
    type,
    source,
    ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope
  )
}

// eslint-disable-next-line complexity -- renders properties, index signatures, and nested members
function renderTypeMembers(
  checker: ts.TypeChecker,
  type: ts.Type,
  source: ts.Node,
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
      (ts.getCombinedModifierFlags(declaration as ts.Declaration) & ts.ModifierFlags.Readonly) !== 0
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
  checker: ts.TypeChecker,
  type: ts.Type,
  source: ts.Node,
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
  checker: ts.TypeChecker,
  type: ts.Type,
  source: ts.Node,
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
  const id = (type as ts.Type & { id?: number }).id
  if (id !== undefined && seen.has(id)) return lines
  if (id !== undefined) seen.add(id)
  lines.push(
    ...renderTypeMembers(checker, type, source, indent, seen),
    ...renderSignatures(checker, type, source, indent)
  )
  return lines
}

export function generateSurfaceSnapshot(root: string): string {
  const { checker, source } = compiler(root)
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
  const generated = `${lines.join('\n').trimEnd()}\n`
  const previous = existsSync(join(root, SNAPSHOT_NAME))
    ? readFileSync(join(root, SNAPSHOT_NAME), 'utf8')
    : ''
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    version: string
  }
  return applySinceAnnotations(generated, previous, packageJson.version)
}

function validateExportSince(
  line: string,
  next: string,
  version: number[],
  currentVersion: string
): string[] {
  const since = SINCE_VALUE_PATTERN.exec(next)?.[1]
  if (!since) return [`${line} is missing since`]
  return since
    .split('.')
    .map(Number)
    .some((part, i) => part > (version[i] ?? 0))
    ? [`${line} since ${since} exceeds ${currentVersion}`]
    : []
}

function validateMemberSince(line: string, next: string): string[] {
  return SINCE_VALUE_PATTERN.exec(next.trim()) ? [] : [`${line} is missing since`]
}

export function validateSinceIndex(snapshot: string, currentVersion = '1.4.0'): string[] {
  const version = currentVersion.split('.').map(Number)
  const lines = snapshot.split('\n')
  const errors: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const next = lines.slice(index + 1).find((candidate) => candidate.trim().length > 0) ?? ''
    if (line.startsWith('## export '))
      errors.push(...validateExportSince(line, next, version, currentVersion))
    const trimmed = line.trimStart()
    if (trimmed.startsWith('- member: ')) errors.push(...validateMemberSince(line, next))
    if (trimmed.startsWith('- index-signature: ')) errors.push(...validateMemberSince(line, next))
  }
  return errors
}

export function assertSurfaceSnapshotIsFresh(
  root: string
): { ok: true } | { ok: false; errors: string[] } {
  const snapshot = readFileSync(join(root, SNAPSHOT_NAME), 'utf8')
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    version: string
  }
  const errors = validateSinceIndex(snapshot, packageJson.version)
  if (errors.length > 0) return { ok: false, errors }
  const expected = generateSurfaceSnapshot(root)
  return expected === snapshot
    ? { ok: true }
    : {
        ok: false,
        errors: [
          'public contract changed: update api-surface.snapshot.md and classify the change against AC-2',
        ],
      }
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes('--write')) {
  const root = process.cwd()
  writeFileSync(join(root, SNAPSHOT_NAME), generateSurfaceSnapshot(root))
}
