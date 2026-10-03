// Story 68.6 AC-1/AC-2/AC-3 — the three hooks files in PV's own build (empty contributions).
import { describe, expect, it } from 'vitest'
import * as serverHooks from './hooks.server.js'
import * as universalHooks from './hooks.js'
import * as clientHooks from './hooks.client.js'

describe('PV hooks files with empty contributions (AC-3, Q7)', () => {
  it('server: handle is a function; every other hook is undefined so Kit defaults run', () => {
    expect(typeof serverHooks.handle).toBe('function')
    expect(serverHooks.handleFetch).toBeUndefined()
    expect(serverHooks.handleError).toBeUndefined()
    expect(serverHooks.handleValidationError).toBeUndefined()
    expect(serverHooks.init).toBeUndefined()
    expect(typeof serverHooks.checkHandoffCorsBootWarning).toBe('function')
  })

  it('universal: reroute and transport are undefined', () => {
    expect(universalHooks.reroute).toBeUndefined()
    expect(universalHooks.transport).toBeUndefined()
  })

  it('client: handleError and init are undefined', () => {
    expect(clientHooks.handleError).toBeUndefined()
    expect(clientHooks.init).toBeUndefined()
  })
})

const SOURCES: Record<string, string> = import.meta.glob(
  ['/src/**/*.ts', '/src/**/*.svelte', '!/src/**/*.test.ts', '!/src/lib/paraglide/**'],
  { query: '?raw', import: 'default', eager: true }
)

describe('virtual module importers (AC-1)', () => {
  it('only server code imports virtual:pv-hooks/server', () => {
    const importers = Object.entries(SOURCES)
      .filter(([, source]) => source.includes("from 'virtual:pv-hooks/server'"))
      .map(([file]) => file)
    expect(importers).toEqual(['/src/hooks.server.ts'])
    for (const file of importers) {
      expect(file === '/src/hooks.server.ts' || file.startsWith('/src/lib/server/')).toBe(true)
    }
  })

  it('PV source has no "is this composed?" branch (one code path, design rule 1)', () => {
    const composition = Object.entries(SOURCES).filter(
      ([file]) =>
        file.startsWith('/src/lib/composition/') ||
        file.startsWith('/src/lib/server/composition/') ||
        file === '/src/lib/security/header-policy.ts' ||
        file === '/src/lib/server/protected-paths.ts' ||
        /^\/src\/hooks(\.server|\.client)?\.ts$/.test(file)
    )
    expect(composition.length).toBeGreaterThanOrEqual(10)
    for (const [file, source] of composition) {
      expect(source, file).not.toMatch(/composition\.lock|isComposed|\$cm\/|\/_cm\//)
      expect(source, file).not.toMatch(
        /allowedHeaders|ALLOWED_HEADERS|ALLOWED_PATHS|permittedPaths|headerWhitelist|HEADER_WHITELIST/
      )
      // AC-14: no module-level mutable state.
      expect(source, file).not.toMatch(/^let /m)
    }
  })
})
