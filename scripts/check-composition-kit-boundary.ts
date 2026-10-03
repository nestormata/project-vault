#!/usr/bin/env tsx
/**
 * Story 68.3 AC-1 / AC-14: the composition kit is published MIT and consumed inside a closed
 * repository, so it must never contain or depend on AGPL code. Two integrity checks:
 *
 * 1. boundary: nothing under `packages/composition-kit/{src,tests}` imports `apps/web`,
 *    `@project-vault/web-host` or any other workspace package (it reads web-host as data), and no
 *    kit file is a byte copy of an `apps/web` file;
 * 2. licence closure: every production dependency of the kit, transitively, is under a permissive
 *    licence (MIT, ISC, BSD, Apache-2.0, 0BSD, BlueOak). GPL, AGPL and LGPL fail.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { toRepoPath, walkFiles } from './lib/scan-utils.js'
import { compareCodeUnits } from './lib/web-host/import-graph.js'

export const KIT_DIR = 'packages/composition-kit'
const KIT_NAME = '@project-vault/composition-kit'
const WORKSPACE_SCOPE = '@project-vault/'
/** Smaller files (an empty barrel, `{}`) are not meaningful copies of anything. */
const MIN_COPY_BYTES = 64
const SOURCE_FILE = /\.(ts|js|mjs|svelte)$/

export const ALLOWED_PRODUCTION_LICENSES: ReadonlySet<string> = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'BlueOak-1.0.0',
])

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Every module specifier a TypeScript/JavaScript file imports, exports from or `import()`s. */
function moduleSpecifiers(text: string, fileName: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text)
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      found.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function forbiddenSpecifier(specifier: string): boolean {
  if (specifier.startsWith(KIT_NAME)) return false
  return specifier.startsWith(WORKSPACE_SCOPE) || /(^|\/)apps\/web(\/|$)/.test(specifier)
}

function webFileHashes(repoRoot: string): Map<string, string> {
  const hashes = new Map<string, string>()
  const webRoot = join(repoRoot, 'apps', 'web')
  for (const file of walkFiles(webRoot, () => true)) {
    const bytes = readFileSync(file)
    if (bytes.length >= MIN_COPY_BYTES) hashes.set(sha256(bytes), toRepoPath(repoRoot, file))
  }
  return hashes
}

export function findBoundaryProblems(repoRoot: string): string[] {
  const problems: string[] = []
  const kitRoot = join(repoRoot, KIT_DIR)
  const files = ['src', 'tests'].flatMap((dir) => walkFiles(join(kitRoot, dir), () => true))
  const webHashes = webFileHashes(repoRoot)
  for (const file of files) {
    const repoPath = toRepoPath(repoRoot, file)
    const bytes = readFileSync(file)
    const original = bytes.length >= MIN_COPY_BYTES ? webHashes.get(sha256(bytes)) : undefined
    if (original !== undefined) {
      problems.push(`${repoPath}: is a byte copy of ${original} (the kit is MIT, apps/web is AGPL)`)
    }
    if (!SOURCE_FILE.test(file)) continue
    for (const specifier of moduleSpecifiers(bytes.toString('utf8'), file)) {
      if (forbiddenSpecifier(specifier)) {
        problems.push(
          `${repoPath}: imports "${specifier}" (the kit must not import apps/web or a workspace package)`
        )
      }
    }
  }
  return problems.sort(compareCodeUnits)
}

/** True when an SPDX expression can be satisfied using only allowed licences. */
export function licenseIsAllowed(expression: string | undefined): boolean {
  if (expression === undefined) return false
  const stripped = expression.replaceAll('(', ' ').replaceAll(')', ' ')
  // OR: any permissive alternative is enough. AND: every term must be permissive.
  return stripped
    .split(/\sOR\s/)
    .some((alternative) =>
      alternative.split(/\sAND\s/).every((term) => ALLOWED_PRODUCTION_LICENSES.has(term.trim()))
    )
}

interface PackageJson {
  name?: string
  license?: string
  dependencies?: Record<string, string>
}

function findInstalled(fromDir: string, name: string): string | undefined {
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, 'node_modules', name, 'package.json')
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function readPackage(path: string): PackageJson {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageJson
}

export function findLicenseClosureProblems(repoRoot: string): string[] {
  const problems: string[] = []
  const kitRoot = join(repoRoot, KIT_DIR)
  const seen = new Set<string>()
  const queue: { name: string; from: string; via: string }[] = Object.keys(
    readPackage(join(kitRoot, 'package.json')).dependencies ?? {}
  ).map((name) => ({ name, from: kitRoot, via: KIT_NAME }))
  for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
    const installed = findInstalled(entry.from, entry.name)
    if (installed === undefined) {
      problems.push(`${entry.name}: not installed (required by ${entry.via}), licence unproven`)
      continue
    }
    const real = realpathSync(installed)
    if (seen.has(real)) continue
    seen.add(real)
    const manifest = readPackage(real)
    if (!licenseIsAllowed(manifest.license)) {
      problems.push(
        `${entry.name}: licence ${JSON.stringify(manifest.license ?? null)} is not permissive (required by ${entry.via})`
      )
    }
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      queue.push({ name, from: dirname(real), via: entry.name })
    }
  }
  return problems.sort(compareCodeUnits)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const problems = [
    ...findBoundaryProblems(process.cwd()),
    ...findLicenseClosureProblems(process.cwd()),
  ]
  if (problems.length === 0) {
    process.stdout.write(
      'check-composition-kit-boundary: the MIT kit imports no AGPL code and has only permissive dependencies — OK\n'
    )
  } else {
    process.stderr.write('FATAL: the composition kit breaks its MIT boundary:\n')
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`)
    process.exitCode = 1
  }
}
