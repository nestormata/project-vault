// Story 68.22 AC-3: the pack-time guard behind the shipped tests' package declarations. A shipped
// test imports packages at runtime and, through test-support code, as types; the published manifest
// must declare every one of them (dependency or peer), or a consumer discovers the gap at test or
// type-check time. Pure: the pack script passes the final maps in and reports the problems.
import { compareCodeUnits } from './import-graph.js'

export interface ShippedTestImports {
  /** The test file, as it should read in the message. */
  file: string
  /** Bare packages the test's graph imports, runtime or type-only. */
  bareImports: readonly string[]
}

export interface DeclaredPackages {
  dependencies: Readonly<Record<string, string>>
  peerDependencies: Readonly<Record<string, string>>
}

/** One problem per undeclared package, naming the first test (in input order) that imports it.
 * `exempt` lists packages the tarball provides itself (the vendored shared source). */
export function undeclaredTestImports(
  shipped: readonly ShippedTestImports[],
  declared: DeclaredPackages,
  exempt: readonly string[]
): string[] {
  const known = new Set([
    ...Object.keys(declared.dependencies),
    ...Object.keys(declared.peerDependencies),
    ...exempt,
  ])
  const firstImporter = new Map<string, string>()
  for (const entry of shipped) {
    for (const name of entry.bareImports) {
      if (!known.has(name) && !firstImporter.has(name)) firstImporter.set(name, entry.file)
    }
  }
  return [...firstImporter]
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(
      ([name, file]) =>
        `shipped test ${file} imports ${name}, which is in neither dependencies nor peerDependencies`
    )
}
