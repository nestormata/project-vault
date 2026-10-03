// Story 68.9 AC-10, Q2: `manifests/test-subjects.json` of the packed @project-vault/web-host.
// For each shipped PV unit test it names the modules the test is ABOUT, so the composer can exclude
// a test whose subject a pack overrode, replaced or removed (and record it in the lock). PV decides
// what a subject is and ships it as data; the MIT kit never parses PV test code.
//
// Subjects of a test T (paths relative to the package, posix):
//   - its direct local imports (relative or `$lib/...`), resolved to files under `src/`;
//   - its same-directory sibling by naming convention (`x.test.ts` -> `x.ts` / `x.svelte`);
//   - (Nestor 2026-10-03, DW-493) what those reach by a bounded transitive walk: imports are followed
//     only from files under `src/lib/` and only to files under `src/lib/`. A test that imports a
//     component that imports a module the pack replaced is therefore about that module too.
// The walk never goes through, and never lists: test-support files (`src/lib/test/**`,
// `*-test-helpers.ts`), other tests, declaration files, the generated paraglide output, CSS/JSON, or
// anything outside `src/lib` (routes are listed only when a test imports them directly, never
// walked from). It is memoised per file and cycle-safe. Guard tests are not listed: a guard scans a
// tree, it is not about one module, and is never excluded.
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

const LIB_PREFIX = 'src/lib/'

/** Files a module imports at runtime that may be walked or listed (inside src/lib, no support). */
function walkableImports(file: string, input: TestSubjectsInput): string[] {
  const code = input.resolver.readFile(file) ?? ''
  return moduleSpecifiers(code, file).flatMap(({ specifier, typeOnly }) => {
    if (typeOnly) return []
    const target = resolveSpecifier(specifier, file, input.resolver)
    if (target.kind !== 'file') return []
    const rel = relativePosix(input.webDir, target.path)
    return rel.startsWith(LIB_PREFIX) && isSubjectFile(rel) ? [target.path] : []
  })
}

/** Every src/lib file reachable from `start` (a src/lib file) through walkable imports. Memoised
 * per file; a cycle simply stops at an already-seen file. */
function libClosure(
  start: string,
  input: TestSubjectsInput,
  memo: Map<string, ReadonlySet<string>>
): ReadonlySet<string> {
  const known = memo.get(start)
  if (known !== undefined) return known
  const seen = new Set<string>([start])
  const queue = [start]
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const next of walkableImports(file, input)) {
      if (!seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
    }
  }
  memo.set(start, seen)
  return seen
}

/** The direct imports and the sibling of a test, relative to the package. */
function directSubjects(testFile: string, code: string, input: TestSubjectsInput): Set<string> {
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
  return found
}

/** All subjects of one test: direct ones plus what they reach inside src/lib. */
function subjectsOf(
  testFile: string,
  code: string,
  input: TestSubjectsInput,
  memo: Map<string, ReadonlySet<string>>
): string[] {
  const found = directSubjects(testFile, code, input)
  const direct = [...found].filter((rel) => isSubjectFile(rel) && rel.startsWith(LIB_PREFIX))
  for (const rel of direct) {
    for (const reached of libClosure(join(input.webDir, rel), input, memo)) {
      found.add(relativePosix(input.webDir, reached))
    }
  }
  return [...found].filter(isSubjectFile).sort(compareCodeUnits)
}

export function buildTestSubjects(input: TestSubjectsInput): TestSubjects {
  const subjects: Record<string, string[]> = {}
  const memo = new Map<string, ReadonlySet<string>>()
  for (const testFile of input.testFiles) {
    const code = input.resolver.readFile(testFile) ?? ''
    if (guardMarker(code) !== undefined) continue
    const list = subjectsOf(testFile, code, input, memo)
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
