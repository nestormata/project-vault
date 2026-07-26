import { describe, expect, it, beforeEach } from 'vitest'
import type { AuthStrategy } from '@project-vault/extension-api'
import type { ExtensionManifest } from '@project-vault/extension-api'
import {
  authStrategies,
  registerAuthStrategy,
  findAuthStrategy,
  wireExtensionAuthStrategy,
  __resetAuthStrategiesForTests,
} from './strategies.js'

const MANIFEST: ExtensionManifest = {
  name: 'com.acme.sso-extension',
  apiVersion: '^1.0.0',
  capabilities: ['auth-provider'],
}

const NOOP_STRATEGY: AuthStrategy = {
  onAuthenticate: async () => ({ externalSubject: 'sub-1', providerName: 'okta' }),
}

beforeEach(() => {
  __resetAuthStrategiesForTests()
})

describe('authStrategies (Story 14.3 AC-1/AC-2)', () => {
  it('AC-1: local strategy occupies index 0 at module load, unconditionally', () => {
    expect(authStrategies[0]?.providerName).toBe('local')
  })

  it('AC-1: local strategy remains at index 0 after any sequence of registerAuthStrategy() calls', () => {
    registerAuthStrategy('okta', NOOP_STRATEGY)
    expect(authStrategies[0]?.providerName).toBe('local')
    expect(authStrategies).toHaveLength(2)
  })

  it("AC-1 edge case: registerAuthStrategy('local', ...) throws synchronously and does not mutate authStrategies", () => {
    expect(() => registerAuthStrategy('local', NOOP_STRATEGY)).toThrow()
    expect(authStrategies).toHaveLength(1)
  })

  it('AC-2: registerAuthStrategy() appends at index 1, never index 0', () => {
    registerAuthStrategy('okta', NOOP_STRATEGY)
    expect(authStrategies[1]).toEqual({ providerName: 'okta', strategy: NOOP_STRATEGY })
  })

  it('AC-2 edge case: a second registration attempt throws rather than producing a duplicate entry', () => {
    registerAuthStrategy('okta', NOOP_STRATEGY)
    expect(() => registerAuthStrategy('okta', NOOP_STRATEGY)).toThrow()
    expect(authStrategies).toHaveLength(2)
  })

  it('AC-2 edge case: no authStrategy hook declared — authStrategies stays local-only', () => {
    expect(authStrategies).toHaveLength(1)
  })

  it('findAuthStrategy resolves a registered non-local provider by name', () => {
    registerAuthStrategy('okta', NOOP_STRATEGY)
    expect(findAuthStrategy('okta')).toEqual({ providerName: 'okta', strategy: NOOP_STRATEGY })
  })

  it('findAuthStrategy returns undefined for an unknown provider name', () => {
    expect(findAuthStrategy('unknown')).toBeUndefined()
  })

  it("findAuthStrategy returns undefined for 'local' — local auth never goes through strategy dispatch", () => {
    expect(findAuthStrategy('local')).toBeUndefined()
  })
})

describe('wireExtensionAuthStrategy (Story 14.3 Task 3 app.ts wiring)', () => {
  it('registers the strategy when the extension loaded with an authStrategy hook', () => {
    wireExtensionAuthStrategy({
      status: 'loaded',
      manifest: MANIFEST,
      loadedAt: new Date().toISOString(),
      hooks: { authStrategy: NOOP_STRATEGY },
    })
    expect(findAuthStrategy(MANIFEST.name)).toEqual({
      providerName: MANIFEST.name,
      strategy: NOOP_STRATEGY,
    })
  })

  it('no-ops when the extension loaded but declared no authStrategy hook', () => {
    wireExtensionAuthStrategy({
      status: 'loaded',
      manifest: MANIFEST,
      loadedAt: new Date().toISOString(),
      hooks: {},
    })
    expect(authStrategies).toHaveLength(1)
  })

  it('no-ops when the extension failed to load', () => {
    wireExtensionAuthStrategy({ status: 'load_failed', reason: 'import_error' })
    expect(authStrategies).toHaveLength(1)
  })

  it('no-ops when no extension is configured', () => {
    wireExtensionAuthStrategy({ status: 'not_configured' })
    expect(authStrategies).toHaveLength(1)
  })

  it('a second invocation does not throw and does not produce a duplicate entry', () => {
    const state: import('../../extensions/loader.js').ExtensionState = {
      status: 'loaded',
      manifest: MANIFEST,
      loadedAt: new Date().toISOString(),
      hooks: { authStrategy: NOOP_STRATEGY },
    }
    wireExtensionAuthStrategy(state)
    expect(() => wireExtensionAuthStrategy(state)).not.toThrow()
    expect(authStrategies).toHaveLength(2)
  })
})
