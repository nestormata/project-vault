import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Story 10.4: `sonar-project.properties` must precisely coverage-exclude only proven
// non-product/test-infrastructure paths (AC-B1, AC-B3) and must never move that same set into
// `sonar.exclusions`, which would additionally hide them from issue analysis (AC-B2). This guard
// parses the actual properties file (not a hand-copied expectation) so a future edit is checked
// against the real merged values.

const PROPERTIES_PATH = resolve(__dirname, '../../../../sonar-project.properties')

type ParsedProperties = Record<string, string>

function parseProperties(raw: string): ParsedProperties {
  // Minimal `.properties` parser: supports `key=value`, `#`/`!` comments, and trailing-`\`
  // line continuation (the standard SonarScanner convention for multi-line lists).
  const logicalLines: string[] = []
  let buffer = ''
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = buffer ? buffer + rawLine.trim() : rawLine
    buffer = ''
    const trimmed = line.trim()
    if (trimmed.endsWith('\\')) {
      buffer = trimmed.slice(0, -1)
      continue
    }
    logicalLines.push(line)
  }

  const result: ParsedProperties = {}
  for (const line of logicalLines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue
    const key = trimmed.slice(0, eqIndex).trim()
    const value = trimmed.slice(eqIndex + 1).trim()
    result[key] = value
  }
  return result
}

function splitList(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function loadProperties(): ParsedProperties {
  const raw = readFileSync(PROPERTIES_PATH, 'utf-8')
  return parseProperties(raw)
}

describe('sonar-project.properties coverage classification', () => {
  it('coverage-excludes only proven non-product/test-infrastructure paths', () => {
    const props = loadProperties()
    const coverageExclusions = splitList(props['sonar.coverage.exclusions'])

    expect(coverageExclusions).toEqual(
      expect.arrayContaining([
        'apps/web/e2e/**',
        'scripts/**',
        'apps/api/src/__tests__/**',
        'apps/api/src/**/*-test-helpers.ts',
        'apps/api/src/**/*-test-bootstrap.ts',
        'apps/web/src/lib/test/**',
        'packages/api-contract-tests/**',
      ])
    )
  })

  it('never coverage-excludes product runtime code merely to raise the metric (AC-B3)', () => {
    const props = loadProperties()
    const coverageExclusions = splitList(props['sonar.coverage.exclusions'])

    const forbiddenProductPatterns = [
      'apps/api/src/modules/**',
      'apps/api/src/workers/**',
      'apps/api/src/routes/**',
      'apps/api/src/plugins/**',
      'apps/api/src/scripts/**',
      'apps/api/src/lib/**',
    ]
    for (const forbidden of forbiddenProductPatterns) {
      expect(coverageExclusions).not.toContain(forbidden)
    }

    // Named product files called out by the story must never appear as literal exclusions.
    const forbiddenNamedFiles = ['dashboard-stats.ts', 'mfa.ts', 'mfa-enforcement.ts']
    for (const name of forbiddenNamedFiles) {
      const matchesNamedFile = coverageExclusions.some((pattern) => pattern.includes(name))
      expect(matchesNamedFile).toBe(false)
    }

    // An imprecise `**/scripts/**` rule would also swallow `apps/api/src/scripts/**`, a runtime
    // production directory (see Dev Notes: "distinguish root scripts/** from runtime
    // apps/api/src/scripts/**"). Only the precise root-relative rule is allowed.
    expect(coverageExclusions).not.toContain('**/scripts/**')
  })

  it('does not move coverage-only exclusions into full source exclusion (AC-B2)', () => {
    const props = loadProperties()
    const sourceExclusions = splitList(props['sonar.exclusions'])

    const coverageOnlyPaths = [
      'apps/api/src/__tests__/**',
      'apps/web/src/lib/test/**',
      'packages/api-contract-tests/**',
      'scripts/**',
    ]
    for (const path of coverageOnlyPaths) {
      expect(sourceExclusions).not.toContain(path)
    }
  })

  it('preserves PR #169s merged e2e coverage exclusion (AC-D4)', () => {
    const props = loadProperties()
    const coverageExclusions = splitList(props['sonar.coverage.exclusions'])
    expect(coverageExclusions).toContain('apps/web/e2e/**')
  })
})
