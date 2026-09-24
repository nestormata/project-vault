/**
 * Story 43.6 (decision D8) — strict SemVer 2.0.0 parsing and §11 precedence, with no dependency
 * (the CLI is a distributed auth tool; every transitive dependency has a supply-chain cost).
 *
 * Strict means: `MAJOR.MINOR.PATCH[-PRERELEASE]`, no leading `v`, no build metadata, no leading
 * zeros in numeric parts, no empty prerelease identifiers. Input length is capped before the regex
 * runs, and the regex itself is anchored and linear.
 */
export type ParsedSemver = {
  major: number
  minor: number
  patch: number
  prerelease: (string | number)[]
}

const MAX_SEMVER_LENGTH = 128
const NUMERIC = '0|[1-9]\\d*'
const PRERELEASE_ID = '(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)'
const STRICT_SEMVER = new RegExp(
  `^(${NUMERIC})\\.(${NUMERIC})\\.(${NUMERIC})(?:-(${PRERELEASE_ID}(?:\\.${PRERELEASE_ID})*))?$`
)
const NUMERIC_ID = /^\d+$/

function toSafeInt(value: string): number | null {
  const n = Number(value)
  return Number.isSafeInteger(n) ? n : null
}

function parsePrerelease(raw: string | undefined): (string | number)[] | null {
  const prerelease: (string | number)[] = []
  for (const id of raw ? raw.split('.') : []) {
    if (!NUMERIC_ID.test(id)) {
      prerelease.push(id)
      continue
    }
    const n = toSafeInt(id)
    if (n === null) return null
    prerelease.push(n)
  }
  return prerelease
}

export function parseStrictSemver(value: string): ParsedSemver | null {
  if (typeof value !== 'string' || value.length > MAX_SEMVER_LENGTH) return null
  const match = STRICT_SEMVER.exec(value)
  if (!match) return null
  const [major, minor, patch] = [match[1], match[2], match[3]].map((part) =>
    toSafeInt(part as string)
  )
  const prerelease = parsePrerelease(match[4])
  if (major == null || minor == null || patch == null || prerelease === null) return null
  return { major, minor, patch, prerelease }
}

function compareIdentifiers(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  // Numeric identifiers always have lower precedence than alphanumeric ones.
  if (typeof a === 'number') return -1
  if (typeof b === 'number') return 1
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** Negative when `a < b`, zero when equal precedence, positive when `a > b`. */
export function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch
  if (core !== 0) return core
  // A version without a prerelease has higher precedence than one with.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return b.prerelease.length - a.prerelease.length
  }
  const shared = Math.min(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < shared; i++) {
    const diff = compareIdentifiers(
      a.prerelease[i] as string | number,
      b.prerelease[i] as string | number
    )
    if (diff !== 0) return diff
  }
  return a.prerelease.length - b.prerelease.length
}

/** Convenience: compares two strict-semver strings; `null` if either does not parse. */
export function compareSemverStrings(a: string, b: string): number | null {
  const pa = parseStrictSemver(a)
  const pb = parseStrictSemver(b)
  if (!pa || !pb) return null
  return compareSemver(pa, pb)
}
