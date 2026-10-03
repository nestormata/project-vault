// Story 68.9 AC-10, Q2: `manifests/test-subjects.json` of the packed @project-vault/web-host.
// For each shipped PV unit test it names the modules the test is ABOUT, so the composer can exclude
// a test whose subject a pack overrode, replaced or removed (and record it in the lock). PV decides
// what a subject is and ships it as data; the MIT kit never parses PV test code.
//
// Subjects of a test T (paths relative to the package, posix):
//   - its direct local imports (relative or `$lib/...`), resolved to files under `src/`;
//   - its same-directory sibling by naming convention (`x.test.ts` -> `x.ts` / `x.svelte`).
// Never subjects: transitive imports, test-support files (`src/lib/test/**`, `*-test-helpers.ts`),
// declaration files, the generated paraglide output, other tests, and anything outside `src/`. Guard tests are not listed: a guard
// scans a tree, it is not about one module, and is never excluded.
import { dirname, basename, join } from 'node:path'
import {
  isTestFile,
  isTestSupportFile,
  moduleSpecifiers,
  relativePosix,
  resolveSpecifier,
  type GraphResolver,
} from './import-graph.js'
import { guardMarker } from './guard-registry.js'

export const TEST_SUBJECTS_MANIFEST = 'test-subjects.json'

export interface TestSubjectsInput {
  webDir: string
  /** Absolute paths of the shipped self-contained tests. */
  testFiles: readonly string[]
  resolver: GraphResolver
}

export interface TestSubjects {
  text: string
  subjects: Record<string, string[]>
}

function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function isSubjectFile(rel: string): boolean {
  return (
    rel.startsWith('src/') &&
    !rel.startsWith('src/lib/paraglide/') &&
    !rel.endsWith('.d.ts') &&
    !isTestFile(rel) &&
    !isTestSupportFile(rel) &&
    !/\.(css|json)$/.test(rel)
  )
}

/** `x.test.ts` / `x.server.test.ts` -> candidate sibling files `x.ts`, `x.svelte`, `x.server.ts`. */
function siblingCandidates(testFile: string): string[] {
  const name = basename(testFile).replace(/\.test\.[cm]?[jt]s$/, '')
  const dir = dirname(testFile)
  return ['.ts', '.svelte', '.js'].map((extension) => join(dir, `${name}${extension}`))
}

export function buildTestSubjects(input: TestSubjectsInput): TestSubjects {
  const subjects: Record<string, string[]> = {}
  for (const testFile of input.testFiles) {
    const code = input.resolver.readFile(testFile) ?? ''
    if (guardMarker(code) !== undefined) continue
    const found = new Set<string>()
    for (const { specifier } of moduleSpecifiers(code, testFile)) {
      const target = resolveSpecifier(specifier, testFile, input.resolver)
      if (target.kind === 'file') found.add(relativePosix(input.webDir, target.path))
    }
    for (const sibling of siblingCandidates(testFile)) {
      if (input.resolver.readFile(sibling) !== undefined) {
        found.add(relativePosix(input.webDir, sibling))
      }
    }
    const list = [...found].filter(isSubjectFile).sort(compareCodeUnits)
    if (list.length > 0) subjects[relativePosix(input.webDir, testFile)] = list
  }
  const ordered = Object.fromEntries(
    Object.entries(subjects).sort(([a], [b]) => compareCodeUnits(a, b))
  )
  return {
    text: `${JSON.stringify({ schemaVersion: 1, subjects: ordered }, null, 2)}\n`,
    subjects: ordered,
  }
}
