import { describe, expect, it } from 'vitest'
import type { ActionResult, ModuleActionContext } from './module-action.js'
import type { OAuthHandoffHooks, OAuthHandoffRedirectResult } from './oauth-handoff.js'

const REPOSITORY_SELECT_URL = 'https://pv.example/repository/select'

function baseContext(overrides: Partial<ModuleActionContext> = {}): ModuleActionContext {
  return {
    slot: 'oauth-handoff',
    identity: { userId: 'user_1', orgRole: 'member' },
    orgId: 'org_1',
    locale: 'en',
    theme: { name: null },
    ...overrides,
  }
}

describe('OAuthHandoffHooks type (Story 39.1 AC1/AC2/AC6/AC9)', () => {
  it('onOAuthStart resolves a redirect result carrying url + state', async () => {
    const hook: OAuthHandoffHooks = {
      onOAuthStart: () =>
        Promise.resolve({
          outcome: 'redirect',
          url: 'https://provider.example/authorize?client_id=abc',
          state: { nonce: 'abc' },
        }),
      onOAuthCallback: () => Promise.resolve({ outcome: 'error' }),
    }
    const result = await hook.onOAuthStart(baseContext(), { action: { kind: 'oauth-start' } })
    expect(result).toEqual<OAuthHandoffRedirectResult>({
      outcome: 'redirect',
      url: 'https://provider.example/authorize?client_id=abc',
      state: { nonce: 'abc' },
    })
  })

  it('onOAuthStart may resolve a non-redirect ActionResult instead (AC6)', async () => {
    const outcomes: ActionResult[] = [
      { outcome: 'denied' },
      { outcome: 'denied', message: 'not allowed' },
      { outcome: 'validation_failed', message: 'bad request' },
      { outcome: 'conflict' },
      { outcome: 'error' },
    ]
    for (const outcome of outcomes) {
      const hook: OAuthHandoffHooks = {
        onOAuthStart: () => Promise.resolve(outcome),
        onOAuthCallback: () => Promise.resolve(outcome),
      }
      const started = await hook.onOAuthStart(baseContext(), { action: { kind: 'x' } })
      expect(started).toEqual(outcome)
    }
  })

  it('onOAuthCallback receives the recovered state verbatim and the raw provider query — no ModuleActionContext (no PV session exists at this point)', async () => {
    let seenState: Record<string, unknown> | undefined
    let seenQuery: Record<string, string> | undefined
    const hook: OAuthHandoffHooks = {
      onOAuthStart: () =>
        Promise.resolve({
          outcome: 'redirect',
          url: 'https://provider.example/authorize',
          state: {},
        }),
      onOAuthCallback: (query, state) => {
        seenState = state
        seenQuery = query
        return Promise.resolve({
          outcome: 'redirect',
          url: REPOSITORY_SELECT_URL,
          state: {},
        })
      },
    }
    await hook.onOAuthCallback(
      { code: 'abc123', state: 'opaque' },
      { nonce: 'abc', extensionOwned: true }
    )
    expect(seenQuery).toEqual({ code: 'abc123', state: 'opaque' })
    expect(seenState).toEqual({ nonce: 'abc', extensionOwned: true })
  })

  it('onOAuthCallback resolves a redirect result for the second, final redirect', async () => {
    const hook: OAuthHandoffHooks = {
      onOAuthStart: () =>
        Promise.resolve({
          outcome: 'redirect',
          url: 'https://provider.example/authorize',
          state: {},
        }),
      onOAuthCallback: () =>
        Promise.resolve({
          outcome: 'redirect',
          url: REPOSITORY_SELECT_URL,
          state: {},
        }),
    }
    const result = await hook.onOAuthCallback({ code: 'abc' }, {})
    expect(result).toEqual({
      outcome: 'redirect',
      url: REPOSITORY_SELECT_URL,
      state: {},
    })
  })
})
