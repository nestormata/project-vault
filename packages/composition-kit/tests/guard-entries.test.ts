import { describe, expect, it } from 'vitest'
import {
  defineGuardEntries,
  generatedEntriesText,
  mergeGuardEntries,
  sectionHashes,
  validateGuardEntries,
  type MapContext,
} from '../src/guard-entries.js'

const BILLING = 'src/lib/billing/draft.ts'
const BILLING_SERVER = 'src/routes/billing/+page.server.ts'
const BILLING_ROUTE = 'src/routes/(billing)/[id]/+page.svelte'
const APPLY_THEME = 'src/lib/theme/apply-theme.ts'
const THEME_STATE = 'src/lib/state/theme.svelte.ts'
const CM_BILLING = 'src/lib/_cm/billing/draft.ts'
const GOOD = {
  browserStorage: {
    sessionStorage: [{ file: BILLING, keys: ['cm:billing-draft'], reason: 'non-sensitive id' }],
  },
}

function problemsOf(raw: unknown): string[] {
  return validateGuardEntries(raw).problems
}

const context: MapContext = {
  relocated: new Map([[BILLING, CM_BILLING]]),
  overlayPaths: new Set([BILLING_SERVER, APPLY_THEME]),
  changedHostPaths: new Set([APPLY_THEME, 'src/routes/ready/+server.ts']),
}

describe('guard entries validation (Story 68.9 AC-3)', () => {
  it('accepts a well-formed file, empty sections and an empty object', () => {
    expect(problemsOf(GOOD)).toEqual([])
    expect(problemsOf({})).toEqual([])
    expect(problemsOf({ browserStorage: {}, internalApiConsumers: {}, externalHrefs: {} })).toEqual(
      []
    )
    expect(defineGuardEntries(GOOD)).toBe(GOOD)
  })

  it('notes an unknown top-level section instead of failing', () => {
    const result = validateGuardEntries({ ...GOOD, futureThing: [] })
    expect(result.problems).toEqual([])
    expect(result.notes).toEqual([
      'unknown guard entries section "futureThing" ignored (a newer kit may give it meaning)',
    ])
  })

  it('rejects an entry with no reason, naming a ready-to-paste fix and the alternative', () => {
    const [problem] = problemsOf({
      browserStorage: { sessionStorage: [{ file: BILLING, keys: ['k'] }] },
    })
    expect(problem).toContain('browserStorage.sessionStorage[0] has no reason')
    expect(problem).toContain("keys: ['<key>']")
    expect(problem).toContain('the alternative is to fix the code')
  })

  it('rejects empty keys and unsafe key characters', () => {
    const entry = (keys: unknown) => ({
      browserStorage: { localStorage: [{ file: BILLING, keys, reason: 'r' }] },
    })
    expect(problemsOf(entry([]))[0]).toContain('non-empty array')
    for (const key of ['a"b', "a'b", 'a`b', 'a\\b', 'a\nb']) {
      expect(problemsOf(entry([key]))[0], key).toContain(
        'holds a quote, backtick, backslash or newline'
      )
    }
    expect(problemsOf(entry(['cm:préférences:é'])).length).toBe(0)
  })

  it('rejects a duplicate (api, file) pair instead of unioning the keys', () => {
    const twice = [
      { file: BILLING, keys: ['a'], reason: 'r' },
      { file: `./${BILLING}`, keys: ['b'], reason: 'r' },
    ]
    expect(problemsOf({ browserStorage: { sessionStorage: twice } })).toEqual([
      `duplicate guard entry browserStorage.sessionStorage[1] for ${BILLING} (sessionStorage)`,
    ])
    // the same file under two different APIs is two entries, not a duplicate
    expect(
      problemsOf({
        browserStorage: {
          sessionStorage: [twice[0]],
          localStorage: [twice[0]],
        },
      })
    ).toEqual([])
  })

  it('rejects paths that leave the pack, absolute paths and backslashes', () => {
    for (const file of ['../x.ts', '/etc/x.ts', 'a\\b.ts', '', '.']) {
      const problems = problemsOf({
        browserStorage: { sessionStorage: [{ file, keys: ['k'], reason: 'r' }] },
      })
      expect(problems.length, file).toBeGreaterThan(0)
    }
  })

  it('rejects code: a function anywhere is not data', () => {
    expect(problemsOf({ browserStorage: { release: () => [] } })[0]).toContain('plain data')
    expect(problemsOf('x')[0]).toContain('must be an object')
    expect(problemsOf([])[0]).toContain('must be an object')
  })

  it('validates route classifications: shape, reason and duplicate METHOD URL', () => {
    const entry = { method: 'GET', url: '/api/v1/cm/health', class: 'public', reason: 'health' }
    expect(problemsOf({ routeClassifications: [entry] })).toEqual([])
    expect(problemsOf({ routeClassifications: [entry, entry] })[0]).toContain('classified twice')
    expect(problemsOf({ routeClassifications: [{ ...entry, method: 'get' }] })[0]).toContain(
      'upper-case'
    )
    expect(problemsOf({ routeClassifications: [{ ...entry, url: 'api' }] })[0]).toContain(
      'starting with "/"'
    )
    expect(problemsOf({ routeClassifications: [{ ...entry, reason: '' }] })[0]).toContain(
      'no reason'
    )
  })

  it('has no count or length cap', () => {
    const many = Array.from({ length: 2000 }, (_, index) => ({
      file: `src/lib/f${index}.ts`,
      keys: ['k'],
      reason: 'x'.repeat(5000),
    }))
    expect(problemsOf({ browserStorage: { sessionStorage: many } })).toEqual([])
  })
})

describe('guard entries mapping (Story 68.9 AC-3, Q10)', () => {
  it('maps a pack path to its composed location and keeps overlay paths in place', () => {
    const { merged, problems } = mergeGuardEntries(
      {
        browserStorage: {
          sessionStorage: [{ file: BILLING, keys: ['b', 'a', 'a'], reason: 'r' }],
          localStorage: [{ file: APPLY_THEME, keys: ['k'], reason: 'r' }],
        },
        internalApiConsumers: { add: [BILLING_SERVER] },
      },
      context
    )
    expect(problems).toEqual([])
    expect(merged.browserStorage.sessionStorage).toEqual([
      { file: CM_BILLING, keys: ['a', 'b'], reason: 'r' },
    ])
    expect(merged.browserStorage.localStorage[0]?.file).toBe(APPLY_THEME)
    expect(merged.internalApiConsumers.add).toEqual([BILLING_SERVER])
  })

  it('fails an entry that maps to no composed file (stale carve-out)', () => {
    const { problems } = mergeGuardEntries(
      {
        browserStorage: {
          sessionStorage: [{ file: 'src/lib/billing/missing.ts', keys: ['k'], reason: 'r' }],
        },
        internalApiConsumers: { add: ['src/nope.ts'] },
        externalHrefs: {
          allow: [{ file: 'src/nope.svelte', href: 'https://x.example', reason: 'r' }],
        },
      },
      context
    )
    expect(problems).toHaveLength(3)
    expect(problems.every((problem) => problem.includes('maps to no composed file'))).toBe(true)
    expect(problems[0]).toContain(
      'browserStorage.sessionStorage[0].file "src/lib/billing/missing.ts"'
    )
  })

  it('does not map a PV file the pack never touched (a PV carve-out is PV data)', () => {
    const { problems } = mergeGuardEntries(
      {
        browserStorage: {
          sessionStorage: [{ file: THEME_STATE, keys: ['k'], reason: 'r' }],
        },
      },
      context
    )
    expect(problems[0]).toContain('stale carve-out')
  })

  it('lets a release name only a file the pack overrode, replaced or removed', () => {
    const ok = mergeGuardEntries(
      {
        browserStorage: { release: [APPLY_THEME] },
        internalApiConsumers: { release: ['src/routes/ready/+server.ts'] },
      },
      context
    )
    expect(ok.problems).toEqual([])
    expect(ok.merged.browserStorage.release).toEqual([APPLY_THEME])
    const bad = mergeGuardEntries({ browserStorage: { release: [THEME_STATE] } }, context)
    expect(bad.problems[0]).toContain('cannot release an entry for a file CM did not change')
  })

  it('reports two entries that differ only by case', () => {
    const { problems } = mergeGuardEntries(
      {
        browserStorage: {
          sessionStorage: [
            { file: BILLING_SERVER, keys: ['a'], reason: 'r' },
            { file: APPLY_THEME, keys: ['a'], reason: 'r' },
            { file: 'src/lib/Theme/apply-theme.ts', keys: ['a'], reason: 'r' },
          ],
        },
      },
      {
        ...context,
        overlayPaths: new Set([
          ...context.overlayPaths,
          'src/lib/Theme/apply-theme.ts',
          BILLING_SERVER,
        ]),
      }
    )
    expect(problems).toEqual([
      'guard entries browserStorage.sessionStorage differ only by case: src/lib/Theme/apply-theme.ts, src/lib/theme/apply-theme.ts',
    ])
  })

  it('matches parentheses and brackets literally', () => {
    const paths = new Set([BILLING_ROUTE])
    const { merged, problems } = mergeGuardEntries(
      { internalApiConsumers: { add: [BILLING_ROUTE] } },
      { ...context, overlayPaths: paths }
    )
    expect(problems).toEqual([])
    expect(merged.internalApiConsumers.add).toEqual([BILLING_ROUTE])
  })

  it('writes every section, a marker first, byte-stably, and hashes per section', () => {
    const { merged } = mergeGuardEntries(undefined, context)
    const text = generatedEntriesText(merged)
    expect(text.startsWith('{\n  "_generated"')).toBe(true)
    expect(text.endsWith('\n')).toBe(true)
    expect(generatedEntriesText(merged)).toBe(text)
    const hashes = sectionHashes(JSON.parse(text))
    expect(Object.keys(hashes)).toEqual([
      'browserStorage',
      'externalHrefs',
      'internalApiConsumers',
      'routeClassifications',
    ])
    expect(Object.values(hashes).every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true)
  })

  // The web guards (AGPL) recompute this value with their own copy of the canonical JSON; the same
  // vector is pinned in apps/web/src/lib/test/guard-root.test.ts.
  it('pins the canonical hash vector shared with the web guards', () => {
    expect(sectionHashes({ _generated: 'x', demo: { b: [2, 1], a: { d: 1, c: null } } })).toEqual({
      demo: 'fe22be92ff0e701c45153b01eea0c202e55d082dd462131d3428dac89670b9b9',
    })
  })
})
