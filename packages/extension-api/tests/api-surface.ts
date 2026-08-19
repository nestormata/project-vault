import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const SNAPSHOT_NAME = 'api-surface.snapshot.md'

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
    lines.push(`${indent}- member: \`${property.name}${optional}\``)
    lines.push(`${indent}  - since: 1.0.0`)
    lines.push(...renderType(checker, propertyType, declaration, `${indent}  `, seen).slice(1))
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
  if (type.isUnion())
    lines.push(
      `${indent}- union-members: ${type.types.map((member) => `\`${typeText(checker, member, source)}\``).join(', ')}`
    )
  if (type.isIntersection())
    lines.push(
      `${indent}- intersection-members: ${type.types.map((member) => `\`${typeText(checker, member, source)}\``).join(', ')}`
    )
  const id = (type as ts.Type & { id?: number }).id
  if (id !== undefined && seen.has(id)) return lines
  if (id !== undefined) seen.add(id)
  lines.push(...renderTypeMembers(checker, type, source, indent, seen))
  lines.push(...renderSignatures(checker, type, source, indent))
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
    lines.push(`## export \`${symbol.name}\``, '')
    lines.push('- since: 1.0.0')
    lines.push(`- kind: ${target.flags & ts.SymbolFlags.Type ? 'type' : 'value'}`)
    lines.push(...renderType(checker, type, declaration, '', new Set()))
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

function validateExportSince(
  line: string,
  next: string,
  version: number[],
  currentVersion: string
): string[] {
  const since = next.match(/^- since: (\d+\.\d+\.\d+)/)?.[1]
  if (!since) return [`${line} is missing since`]
  return since
    .split('.')
    .map(Number)
    .some((part, i) => part > (version[i] ?? 0))
    ? [`${line} since ${since} exceeds ${currentVersion}`]
    : []
}

function validateMemberSince(line: string, next: string): string[] {
  return /^- since: \d+\.\d+\.\d+/.test(next.trim()) ? [] : [`${line} is missing since`]
}

export function validateSinceIndex(snapshot: string, currentVersion = '1.4.0'): string[] {
  const version = currentVersion.split('.').map(Number)
  const lines = snapshot.split('\n')
  const errors: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const next = lines.slice(index + 1).find((candidate) => candidate.trim().length > 0) ?? ''
    if (/^## export /.test(line))
      errors.push(...validateExportSince(line, next, version, currentVersion))
    if (/^- member: /.test(line)) errors.push(...validateMemberSince(line, next))
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
