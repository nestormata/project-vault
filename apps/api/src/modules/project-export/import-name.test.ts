import { describe, expect, it } from 'vitest'
import {
  IMPORT_NAME_MAX_LENGTH,
  MAX_IMPORT_NAME_ATTEMPTS,
  buildImportNameCandidates,
  pickImportName,
} from './import-name.js'

const IMPORTED_SUFFIX = ' (imported)'
const NAME = 'Payments API'

describe('buildImportNameCandidates (Story 62-2 AC-5)', () => {
  it('lists the bare name first, then (imported), (imported 2), (imported 3), ...', () => {
    const candidates = buildImportNameCandidates(NAME)
    expect(candidates.slice(0, 4)).toEqual([
      NAME,
      `${NAME}${IMPORTED_SUFFIX}`,
      `${NAME} (imported 2)`,
      `${NAME} (imported 3)`,
    ])
    expect(candidates).toHaveLength(MAX_IMPORT_NAME_ATTEMPTS + 1)
  })

  it('truncates the base so every suffixed candidate fits the 128-char limit', () => {
    const base = 'a'.repeat(IMPORT_NAME_MAX_LENGTH)
    const candidates = buildImportNameCandidates(base)
    expect(candidates[0]).toBe(base)
    for (const candidate of candidates) {
      expect(candidate.length).toBeLessThanOrEqual(IMPORT_NAME_MAX_LENGTH)
    }
    expect(candidates[1]).toBe(
      `${'a'.repeat(IMPORT_NAME_MAX_LENGTH - IMPORTED_SUFFIX.length)} (imported)`
    )
  })

  it('trims trailing whitespace left by the truncation so no double space precedes the suffix', () => {
    const base = `${'a'.repeat(IMPORT_NAME_MAX_LENGTH - IMPORTED_SUFFIX.length - 1)} bbbb`
    const candidates = buildImportNameCandidates(base)
    expect(candidates[1]).not.toContain('  (imported)')
    expect(candidates[1]?.endsWith(IMPORTED_SUFFIX)).toBe(true)
  })
})

describe('pickImportName (Story 62-2 AC-5)', () => {
  const candidates = buildImportNameCandidates(NAME)

  it('keeps the name unchanged when nothing collides (regression guard)', () => {
    expect(pickImportName(candidates, new Set())).toBe(NAME)
  })

  it('picks (imported) when only the bare name is taken', () => {
    expect(pickImportName(candidates, new Set([0]))).toBe(`${NAME}${IMPORTED_SUFFIX}`)
  })

  it('picks the first free numbered suffix', () => {
    expect(pickImportName(candidates, new Set([0, 1]))).toBe(`${NAME} (imported 2)`)
    expect(pickImportName(candidates, new Set([0, 1, 2, 4]))).toBe(`${NAME} (imported 3)`)
  })

  it('keeps the last candidate when every candidate is taken (names are not unique)', () => {
    const all = new Set(candidates.map((_, index) => index))
    expect(pickImportName(candidates, all)).toBe(candidates[candidates.length - 1])
  })

  it('treats LIKE metacharacters literally: candidates are verbatim strings, never patterns', () => {
    const hostile = buildImportNameCandidates("100%_done'; --")
    expect(hostile[0]).toBe("100%_done'; --")
    expect(hostile[1]).toBe("100%_done'; -- (imported)")
  })
})
