// Story 68.9 AC-10: which of PV's shipped unit tests are not run over a composed tree because the
// pack overrode, replaced or removed what they are ABOUT (their subject). PV decides what a subject
// is and ships it as data (`manifests/test-subjects.json`); the kit never parses PV test code and
// never excludes a test because a CM file touched it by accident: only an exact subject match counts.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareCodeUnits } from './paths.js'

export interface TestSubjects {
  schemaVersion: number
  subjects: Record<string, string[]>
}

const SUPPORTED_SCHEMA = 1

export function readTestSubjects(hostDir: string): {
  subjects?: ReadonlyMap<string, readonly string[]>
  problems: string[]
  notes: string[]
} {
  const path = join(hostDir, 'manifests', 'test-subjects.json')
  if (!existsSync(path)) {
    return {
      problems: [],
      notes: ['host publishes no test-subjects manifest; no PV test was excluded automatically'],
    }
  }
  let raw: Partial<TestSubjects>
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<TestSubjects>
  } catch {
    return { problems: [`${path} is not valid JSON`], notes: [] }
  }
  if (raw.schemaVersion !== SUPPORTED_SCHEMA || raw.subjects === undefined) {
    return {
      problems: [
        `manifests/test-subjects.json has an unsupported schemaVersion (${String(raw.schemaVersion)}); upgrade @project-vault/composition-kit`,
      ],
      notes: [],
    }
  }
  return { subjects: new Map(Object.entries(raw.subjects)), problems: [], notes: [] }
}

export interface ExclusionInput {
  subjects: ReadonlyMap<string, readonly string[]>
  /** Host paths the pack overrides, replaces (the resolved host file) or removes. */
  changed: ReadonlySet<string>
  /** Host test files the pack removed or overrode: they are CM's now, or gone, never a PV test. */
  notPvTests: ReadonlySet<string>
}

/** Sorted POSIX paths of the PV tests with a changed subject. Recomputed on every run, never read
 * back from a previous lock. */
export function excludedPvTests(input: ExclusionInput): string[] {
  return [...input.subjects]
    .filter(([test]) => !input.notPvTests.has(test))
    .filter(([, subjects]) => subjects.some((subject) => input.changed.has(subject)))
    .map(([test]) => test)
    .sort(compareCodeUnits)
}

const SECURITY_PATH = /(^|\/)(server|hooks|auth)(\/|\.|-)|routes\/\(auth\)/

/** Excluded tests whose path suggests they guard security behaviour (report-only, never refused). */
export function securityRelevant(excluded: readonly string[]): string[] {
  return excluded.filter((test) => SECURITY_PATH.test(test))
}

export const EXCLUSION_RATE_WARN_PERCENT = 25

export function exclusionNotes(excluded: readonly string[], total: number): string[] {
  const security = securityRelevant(excluded)
  const percent = total === 0 ? 0 : Math.round((excluded.length * 100) / total)
  return [
    ...(security.length === 0
      ? []
      : [`${security.length} excluded PV test(s) look security relevant: ${security.join(', ')}`]),
    ...(percent > EXCLUSION_RATE_WARN_PERCENT
      ? [`${excluded.length} of ${total} PV tests excluded (${percent}%)`]
      : []),
  ]
}
