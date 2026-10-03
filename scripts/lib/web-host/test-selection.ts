// Story 68.2 AC-6/AC-7 (amended by Nestor 2026-10-02): web-host ships PV's web unit tests that are
// self-contained, so a composer can run them over a composed tree (story 68-9, design §12), and
// still excludes the cross-package ones. Classification is structural, computed per test file:
//   (1) its runtime import graph stays inside the shipped source (apps/web/src) and the vendored
//       @project-vault/shared source;
//   (2) every bare package it imports is a published package resolved in apps/web's lockfile entry
//       (never another workspace package such as a fixture or @project-vault/db);
//   (3) no relative path string in its code (a file it reads, `new URL('../x', import.meta.url)`)
//       resolves outside apps/web/src.
//   (4) it is not on PV_TREE_ONLY_TESTS (an oracle of PV's own un-composed markup).
// A test that breaks any rule is excluded with its reasons; only PV_TREE_ONLY_TESTS is by path.
import { dirname, join, relative, sep } from 'node:path'
import ts from 'typescript'
import { walkImportGraph, type GraphResolver } from './import-graph.js'

export interface TestSelectionContext {
  /** apps/web/src, absolute. */
  webSrc: string
  /** Absolute paths of the vendored shared files (the shared import graph). */
  vendoredShared: ReadonlySet<string>
  /** Bare package names resolvable from apps/web's lockfile entry. */
  lockedPackages: ReadonlySet<string>
  /** Published workspace packages a shipped file may import (@project-vault/extension-api). */
  publishedWorkspacePackages: ReadonlySet<string>
  resolver: GraphResolver
  display: (path: string) => string
}

export interface TestClassification {
  file: string
  selfContained: boolean
  reasons: string[]
  /** Bare packages the test (and the test-support code it reaches) imports. */
  bareImports: string[]
}

/** Tests that are self-contained by import graph but only valid on PV's own un-composed tree,
 * keyed by path suffix under apps/web, with the reason they are excluded from the tarball. */
export const PV_TREE_ONLY_TESTS: ReadonlyMap<string, string> = new Map([
  [
    'src/routes/route-render-snapshot.test.ts',
    "oracle of PV's own un-composed markup; valid only on PV's tree",
  ],
  [
    'src/lib/navigation/nav-render-oracle.test.ts',
    "oracle of PV's own un-composed nav markup (Story 68.7); valid only on PV's tree",
  ],
  [
    'src/lib/navigation/nav-ssr.test.ts',
    "compares PV's server render with the nav render oracle (Story 68.7); valid only on PV's tree",
  ],
  [
    'src/lib/navigation/nav-not-security.test.ts',
    "pins PV's own hooks and (app) layout answers (Story 68.7); valid only on PV's tree",
  ],
  [
    'src/hooks-files.test.ts',
    "pins PV's hooks files with no contributions and who imports the virtual hooks modules; valid only on PV's own build",
  ],
  [
    'src/routes/server-files-wiring.test.ts',
    "pins the shape of every page and layout server file in PV's own build (no actions where PV has none); valid only on PV's own tree",
  ],
])

function pvTreeOnlyReason(file: string): string | undefined {
  const normalized = file.split(sep).join('/')
  for (const [suffix, reason] of PV_TREE_ONLY_TESTS) {
    if (normalized.endsWith(`/${suffix}`)) return reason
  }
  return undefined
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep)
}

/** Relative path literals (`'./x'`, `'../x'`) in a file's code, comments excluded. */
export function relativePathLiterals(code: string): string[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, code)
  const found: string[] = []
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    const isString =
      token === ts.SyntaxKind.StringLiteral || token === ts.SyntaxKind.NoSubstitutionTemplateLiteral
    const value = isString ? scanner.getTokenValue() : ''
    if (value.startsWith('./') || value.startsWith('../')) found.push(value)
  }
  return found
}

function graphReasons(file: string, context: TestSelectionContext) {
  const graph = walkImportGraph([file], context.resolver, context.display)
  const reasons = graph.errors.map((error) => `unresolvable import: ${error}`)
  for (const reached of graph.files) {
    const shipped = isInside(context.webSrc, reached) || context.vendoredShared.has(reached)
    if (!shipped) reasons.push(`imports ${context.display(reached)}, outside the package`)
  }
  const bareImports = [...graph.bareImports.keys()].sort((a, b) => a.localeCompare(b))
  for (const name of bareImports) {
    const workspace = name.startsWith('@project-vault/')
    if (
      workspace &&
      !context.publishedWorkspacePackages.has(name) &&
      name !== '@project-vault/shared'
    ) {
      reasons.push(`imports the workspace package ${name}`)
    } else if (!workspace && !context.lockedPackages.has(name)) {
      reasons.push(`imports ${name}, which apps/web does not resolve`)
    }
  }
  return { reasons, bareImports }
}

/** Classifies one test file. `code` is its text. */
export function classifyTest(
  file: string,
  code: string,
  context: TestSelectionContext
): TestClassification {
  const { reasons, bareImports } = graphReasons(file, context)
  for (const literal of relativePathLiterals(code)) {
    const target = join(dirname(file), literal)
    if (!isInside(context.webSrc, target) && target !== context.webSrc) {
      reasons.push(`reads ${JSON.stringify(literal)}, outside the package`)
    }
  }
  const pvOnly = pvTreeOnlyReason(file)
  if (pvOnly !== undefined) reasons.push(pvOnly)
  return { file, selfContained: reasons.length === 0, reasons, bareImports }
}
