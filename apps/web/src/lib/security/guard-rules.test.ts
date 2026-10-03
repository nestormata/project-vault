import { describe, expect, it } from 'vitest'
import {
  chokePointOffenders,
  consumerViolations,
  effectiveInternalApiConsumers,
  effectiveStorageEntries,
  rawHtmlViolations,
  storageViolations,
  type GuardFile,
} from './guard-rules.js'
import { BASE_INTERNAL_API_CONSUMERS } from '../server/internal-api-consumers.js'
import type { GuardEntries } from '../test/guard-root.js'

const NO_STORAGE: GuardEntries['browserStorage'] = {
  sessionStorage: [],
  localStorage: [],
  release: [],
}
const NO_CONSUMERS: GuardEntries['internalApiConsumers'] = { add: [], release: [] }

const file = (path: string, content: string): GuardFile => ({ path, content })

// A PV carve-out file with its reviewed key, so the stale-entry check stays quiet in unit cases.
const PV_CARVE_OUTS = [
  file('src/lib/theme/apply-theme.ts', "sessionStorage.getItem('dismissedOrphanedTheme')"),
  file('src/routes/(app)/+layout.svelte', 'sessionStorage.length'),
  file(
    'src/lib/components/auth/registration-locale.ts',
    "globalThis.sessionStorage?.getItem('project-vault.registration-locale-pending')"
  ),
  file('src/lib/state/theme.svelte.ts', "localStorage.getItem('pv:preAuthTheme:v1')"),
]

function violations(files: GuardFile[], entries = NO_STORAGE, removed = new Set<string>()) {
  return storageViolations([...PV_CARVE_OUTS, ...files], entries, removed)
}

describe('browser-storage rules (Story 68.9 AC-4)', () => {
  it('passes PV carve-outs that use only their own keys', () => {
    expect(violations([])).toEqual([])
  })

  it('flags use with no entry, naming the file and a ready-to-paste entry', () => {
    const [problem, ...rest] = violations([
      file('src/lib/_cm/session-cache.ts', "sessionStorage.setItem('x', 'y')"),
    ])
    expect(rest).toEqual([])
    expect(problem).toContain('src/lib/_cm/session-cache.ts uses sessionStorage')
    expect(problem).toContain(
      "browserStorage.sessionStorage: [{ file: 'src/lib/_cm/session-cache.ts'"
    )
    expect(problem).toContain('alternative is to stop using browser storage')
  })

  it('does not exempt a file whose path merely ends like a carve-out (no suffix match)', () => {
    const problems = violations([
      file('src/lib/_cm/lib/theme/apply-theme.ts', "sessionStorage.setItem('k', 'v')"),
    ])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('src/lib/_cm/lib/theme/apply-theme.ts uses sessionStorage')
  })

  it('accepts a pack entry for exactly its declared key and rejects another key', () => {
    const entries = {
      ...NO_STORAGE,
      sessionStorage: [
        { file: 'src/lib/billing/draft.ts', keys: ['cm:billing-draft'], reason: 'draft id' },
      ],
    }
    expect(
      violations(
        [file('src/lib/billing/draft.ts', "sessionStorage.setItem('cm:billing-draft', id)")],
        entries
      )
    ).toEqual([])
    const other = violations(
      [file('src/lib/billing/draft.ts', "sessionStorage.setItem('cm:other', id)")],
      entries
    )
    expect(other).toHaveLength(1)
    expect(other[0]).toContain("key 'cm:other'")
  })

  it('checks the keys of a PV carve-out file too (same rule for PV and pack entries)', () => {
    const problems = storageViolations(
      [file('src/lib/theme/apply-theme.ts', "sessionStorage.setItem('someOtherKey', '1')")],
      NO_STORAGE,
      new Set([
        'src/routes/(app)/+layout.svelte',
        'src/lib/components/auth/registration-locale.ts',
        'src/lib/state/theme.svelte.ts',
      ])
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("key 'someOtherKey'")
  })

  it('reports an entry that names a file missing from the tree unless the lock records its removal', () => {
    const entries = {
      ...NO_STORAGE,
      sessionStorage: [{ file: 'src/lib/billing/gone.ts', keys: ['k'], reason: 'r' }],
    }
    expect(violations([], entries)[0]).toContain('names no file in the tree')
    expect(violations([], entries, new Set(['src/lib/billing/gone.ts']))).toEqual([])
  })

  it('reports an entry whose file no longer uses the API (stale exemption)', () => {
    const entries = {
      ...NO_STORAGE,
      sessionStorage: [{ file: 'src/lib/billing/draft.ts', keys: ['k'], reason: 'r' }],
    }
    expect(
      violations([file('src/lib/billing/draft.ts', 'export const x = 1')], entries)[0]
    ).toContain('is stale')
  })

  it('lets a pack release a PV carve-out whose override dropped the use', () => {
    const entries = { ...NO_STORAGE, release: ['src/lib/theme/apply-theme.ts'] }
    const files = PV_CARVE_OUTS.map((entry) =>
      entry.path === 'src/lib/theme/apply-theme.ts' ? file(entry.path, 'export const x = 1') : entry
    )
    expect(storageViolations(files, entries, new Set())).toEqual([])
    expect(effectiveStorageEntries('session', entries).map((e) => e.file)).not.toContain(
      'src/lib/theme/apply-theme.ts'
    )
  })

  it('always flags indexedDB, which has no entry kind', () => {
    expect(violations([file('src/lib/_cm/db.ts', 'indexedDB.open("x")')])[0]).toContain('indexedDB')
  })

  it('flags local storage the same way', () => {
    expect(
      violations([file('src/lib/_cm/prefs.ts', "localStorage.setItem('a','b')")])[0]
    ).toContain('localStorage')
  })
})

describe('raw HTML rule', () => {
  it('flags a CM component and a PV component identically', () => {
    const content = '<div>{@html userBio}</div>'
    const pv = rawHtmlViolations([file('src/lib/components/Bio.svelte', content)])
    const cm = rawHtmlViolations([file('src/lib/_cm/Bio.svelte', content)])
    expect(pv).toEqual(['src/lib/components/Bio.svelte uses raw HTML rendering'])
    expect(cm).toEqual(['src/lib/_cm/Bio.svelte uses raw HTML rendering'])
  })
})

describe('internal API choke point rules (Story 68.9 AC-5)', () => {
  const offending = 'proxy({ fetchFn: globalThis.fetch, base: env.API_BASE_URL })'

  it('flags the regression shape and ignores the typeof annotation', () => {
    expect(
      chokePointOffenders([
        file('src/routes/new/+server.ts', offending),
        file(
          'src/routes/ok/+page.server.ts',
          'async function load(fetch: typeof globalThis.fetch) { return env.API_BASE_URL }'
        ),
      ])
    ).toEqual(['src/routes/new/+server.ts'])
  })

  it('flags CM server code and PV code identically, and exempts only the choke point path', () => {
    expect(chokePointOffenders([file('src/lib/server/_cm/crm.ts', offending)])).toEqual([
      'src/lib/server/_cm/crm.ts',
    ])
    expect(chokePointOffenders([file('src/lib/server/internal-api-tls.ts', offending)])).toEqual([])
  })

  it('needs no entry for compliant CM code', () => {
    expect(
      chokePointOffenders([file('src/lib/server/_cm/crm.ts', 'internalApiFetch(env.API_BASE_URL)')])
    ).toEqual([])
  })

  const readers = BASE_INTERNAL_API_CONSUMERS.map((path) => file(path, 'env.API_BASE_URL'))

  it('passes when every expected consumer is present', () => {
    expect(consumerViolations(readers, NO_CONSUMERS)).toEqual([])
  })

  it('names the release entry when an overridden consumer no longer reads the URL', () => {
    const files = readers.filter((entry) => entry.path !== 'src/routes/ready/+server.ts')
    const [problem] = consumerViolations(files, NO_CONSUMERS)
    expect(problem).toContain('anti-vacuous check, not a rule on your code')
    expect(problem).toContain("internalApiConsumers.release: ['src/routes/ready/+server.ts']")
    expect(
      consumerViolations(files, { add: [], release: ['src/routes/ready/+server.ts'] })
    ).toEqual([])
  })

  it('treats a recorded removal as satisfied and merges additions', () => {
    const files = readers.filter((entry) => entry.path !== 'src/routes/ready/+server.ts')
    expect(
      consumerViolations(files, NO_CONSUMERS, new Set(['src/routes/ready/+server.ts']))
    ).toEqual([])
    expect(
      effectiveInternalApiConsumers({ add: ['src/lib/server/_cm/crm.ts'], release: [] })
    ).toContain('src/lib/server/_cm/crm.ts')
    expect(
      consumerViolations(readers, { add: ['src/lib/server/_cm/crm.ts'], release: [] })[0]
    ).toContain('src/lib/server/_cm/crm.ts')
  })
})
