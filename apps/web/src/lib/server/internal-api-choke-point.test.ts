/**
 * @pv-guard internal-api-choke-point
 * @pv-entries internalApiConsumers
 *
 * Story 43.16 AC-2 regression guard: every server-side consumer of `API_BASE_URL` must go through
 * `internalApiFetch` (the internal-TLS choke point in `internal-api-tls.ts`). A module that reads
 * `API_BASE_URL` and hands `globalThis.fetch` to the api hop would silently send plaintext, or
 * verify against public roots, on the Fly demo.
 *
 * Story 68.9: the tree is PV's own `src` or a composed app root (`PV_GUARD_APP_ROOT`); the list of
 * expected consumers is data that a pack's entries extend or release.
 */
import { describe, expect, it } from 'vitest'
import {
  assertNotVacuous,
  entriesTamperProblem,
  guardSources,
  readGuardEntries,
  readGuardSource,
  removedFiles,
} from '../test/guard-root.js'
import { chokePointOffenders, consumerViolations, type GuardFile } from '../security/guard-rules.js'

function scanned(): GuardFile[] {
  const sources = guardSources(/\.(ts|svelte)$/)
  assertNotVacuous(sources)
  return sources.map((source) => ({ path: source.path, content: readGuardSource(source) }))
}

describe('internalApiFetch is the only path from API_BASE_URL to the api (Story 43.16 AC-2)', () => {
  it('uses the generated guard entries exactly as the lock recorded them', () => {
    const problem = entriesTamperProblem()
    expect(problem, problem ?? '').toBeNull()
  })

  it('scans the known API_BASE_URL consumers', () => {
    const problems = consumerViolations(
      scanned(),
      readGuardEntries().internalApiConsumers,
      removedFiles()
    )
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('no module pairs API_BASE_URL with a raw globalThis.fetch', () => {
    const offenders = chokePointOffenders(scanned())
    expect(
      offenders,
      `raw global fetch next to the API base URL in: ${offenders.join(', ')}`
    ).toEqual([])
  })

  it('flags the regression shape and ignores the typeof annotation (guard self-test)', () => {
    expect(
      chokePointOffenders([
        {
          path: 'src/routes/new/+server.ts',
          content: 'proxyApiRequest({ fetchFn: globalThis.fetch, apiBaseUrl: env.API_BASE_URL })',
        },
        {
          path: 'src/routes/ok/+page.server.ts',
          content:
            'async function load(fetch: typeof globalThis.fetch) { return env.API_BASE_URL }',
        },
      ])
    ).toEqual(['src/routes/new/+server.ts'])
  })
})
