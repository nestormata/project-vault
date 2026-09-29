import { describe, expect, it } from 'vitest'

/**
 * Story 43.16 AC-2 regression guard: every server-side consumer of `API_BASE_URL` must go through
 * `internalApiFetch` (the internal-TLS choke point in `internal-api-tls.ts`). A module that reads
 * `API_BASE_URL` and hands `globalThis.fetch` to the api hop would silently send plaintext, or
 * verify against public roots, on the Fly demo.
 *
 * Sources are loaded with a static `import.meta.glob`, so no dynamic filesystem reads are needed.
 */
const SOURCES: Record<string, string> = import.meta.glob(
  ['/src/**/*.ts', '/src/**/*.svelte', '!/src/**/*.test.ts', '!/src/lib/paraglide/**'],
  { query: '?raw', import: 'default', eager: true }
)

// The choke point itself is the one module allowed to wrap globalThis.fetch.
const CHOKE_POINT = '/src/lib/server/internal-api-tls.ts'

// `globalThis.fetch` used as a value — not the `typeof globalThis.fetch` type annotation many
// load functions use for SvelteKit's own `event.fetch`.
const FETCH_VALUE = /(?<!typeof\s)\bglobalThis\.fetch\b/

function offenders(sources: Record<string, string>): string[] {
  return Object.entries(sources)
    .filter(([file]) => file !== CHOKE_POINT)
    .filter(([, source]) => source.includes('API_BASE_URL') && FETCH_VALUE.test(source))
    .map(([file]) => file)
}

describe('internalApiFetch is the only path from API_BASE_URL to the api (Story 43.16 AC-2)', () => {
  it('scans the known API_BASE_URL consumers', () => {
    const consumers = Object.entries(SOURCES)
      .filter(([, source]) => source.includes('API_BASE_URL'))
      .map(([file]) => file)
    for (const expected of [
      '/src/hooks.server.ts',
      '/src/routes/api/v1/[...path]/+server.ts',
      '/src/routes/ready/+server.ts',
      '/src/routes/api/health/+server.ts',
      '/src/routes/api/v1/auth/handoff/prepare/+server.ts',
      '/src/routes/(auth)/handoff/+page.server.ts',
    ]) {
      expect(consumers).toContain(expected)
    }
  })

  it('no module pairs API_BASE_URL with a raw globalThis.fetch', () => {
    expect(offenders(SOURCES)).toEqual([])
  })

  it('flags the regression shape and ignores the typeof annotation (guard self-test)', () => {
    expect(
      offenders({
        '/src/routes/new/+server.ts':
          'proxyApiRequest({ fetchFn: globalThis.fetch, apiBaseUrl: env.API_BASE_URL })',
        '/src/routes/ok/+page.server.ts':
          'async function load(fetch: typeof globalThis.fetch) { return env.API_BASE_URL }',
      })
    ).toEqual(['/src/routes/new/+server.ts'])
  })
})
