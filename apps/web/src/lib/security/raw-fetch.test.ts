/**
 * @pv-guard raw-fetch
 *
 * Story 62-6: no authenticated API helper under `src/lib/api/` calls the injected fetch directly.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RAW_FETCH_EXCLUSIONS, rawFetchProblems } from './raw-fetch.js'
import { guardAppRoot } from '../test/guard-root.js'

function apiSources(): Record<string, string> {
  const dir = join(guardAppRoot(), 'src/lib/api')
  const names = readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))
  return Object.fromEntries(names.map((name) => [name, readFileSync(join(dir, name), 'utf8')]))
}

describe('raw fetch guard (Story 62-6)', () => {
  it('holds for the api helpers of the tree under test', () => {
    const sources = apiSources()
    expect(Object.keys(sources).length).toBeGreaterThan(5)
    const problems = rawFetchProblems(sources)
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('fails on a raw call that is not excluded (red fixture)', () => {
    const fixture = {
      'widgets.ts': "const r = await fetchFn('/api/v1/widgets', { credentials: 'include' })",
    }
    const problems = rawFetchProblems(fixture, [])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('apiFetch')
  })

  it('ignores client.ts and method calls such as response.fetch(', () => {
    expect(rawFetchProblems({ 'client.ts': 'fetchFn(path)', 'x.ts': 'obj.fetch(a)' }, [])).toEqual(
      []
    )
  })

  it('fails on a stale exclusion', () => {
    const problems = rawFetchProblems(
      { 'vault.ts': 'nothing here' },
      RAW_FETCH_EXCLUSIONS.slice(0, 1)
    )
    expect(problems[0]).toContain('stale exclusion')
  })
})
