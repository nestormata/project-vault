/**
 * @pv-guard raw-fetch
 *
 * Story 62-6: no authenticated API helper under `src/lib/api/` calls the injected fetch directly.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RAW_FETCH_EXCLUSIONS, rawFetchProblems } from './raw-fetch.js'
import { guardAppRoot } from '../test/guard-root.js'

function apiFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return apiFiles(path)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
  })
}

function apiSources(): Record<string, string> {
  const dir = join(guardAppRoot(), 'src/lib/api')
  return Object.fromEntries(
    apiFiles(dir).map((path) => [
      relative(dir, path).split('\\').join('/'),
      readFileSync(path, 'utf8'),
    ])
  )
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

  it.each([
    ['globalThis.fetch', "await globalThis.fetch('/api/v1/widgets')"],
    ['window.fetch', "await window.fetch('/api/v1/widgets')"],
    ['self.fetch', "await self.fetch('/api/v1/widgets')"],
    ['an alias of fetchFn', 'const f = fetchFn\nawait f(url)'],
    ['an alias of globalThis.fetch', 'const f = globalThis.fetch;'],
    ['fetchFn.call', "await fetchFn.call(null, '/api/v1/widgets')"],
    ['fetchFn.apply', "await fetchFn.apply(null, ['/api/v1/widgets'])"],
    ['fetchFn.bind', 'const g = fetchFn.bind(null)'],
    ['an optional call', "await fetchFn?.('/api/v1/widgets')"],
    ['Reflect.apply', "await Reflect.apply(fetchFn, null, ['/x'])"],
  ])('fails on a raw call through %s (red fixture)', (_label, code) => {
    const problems = rawFetchProblems({ 'widgets.ts': code }, [])
    expect(problems.length).toBeGreaterThan(0)
    expect(problems[0]).toContain('apiFetch')
  })

  it('fails on a raw call in a subdirectory of src/lib/api (red fixture)', () => {
    const problems = rawFetchProblems({ 'nested/widgets.ts': "await fetchFn('/api/v1/w')" }, [])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('nested/widgets.ts')
  })

  it('allows passing fetchFn to the client helpers and a nested exclusion', () => {
    expect(
      rawFetchProblems(
        { 'a.ts': "return apiFetch(fetchFn, '/x')\nrun(fetchFn)\nfetchFn === other" },
        []
      )
    ).toEqual([])
    const nested = [{ file: 'sub/p.ts', target: "'/ready'", reason: 'probe' }]
    expect(rawFetchProblems({ 'sub/p.ts': "fetchFn('/ready')" }, nested)).toEqual([])
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
