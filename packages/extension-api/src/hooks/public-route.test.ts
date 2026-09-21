import { describe, expect, it } from 'vitest'
import type { ActionResult } from './module-action.js'
import type { PublicRouteHooks, PublicRouteRequest, PublicRouteResult } from './public-route.js'

function baseRequest(overrides: Partial<PublicRouteRequest> = {}): PublicRouteRequest {
  return {
    method: 'GET',
    pathTemplate: '/redeem/:token',
    params: { token: 'abc123' },
    query: {},
    ...overrides,
  }
}

describe('PublicRouteHooks type (Story 20.13 AC1/AC4)', () => {
  it('onPublicRouteRequest resolves a structured response result carrying status/headers/body', async () => {
    const hook: PublicRouteHooks = {
      onPublicRouteRequest: () =>
        Promise.resolve({
          outcome: 'response',
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: { redeemed: true },
        }),
    }
    const result = await hook.onPublicRouteRequest(baseRequest())
    expect(result).toEqual<PublicRouteResult>({
      outcome: 'response',
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: { redeemed: true },
    })
  })

  it('onPublicRouteRequest may resolve a non-response ActionResult instead, reused unchanged (AC4)', async () => {
    const outcomes: ActionResult[] = [
      { outcome: 'denied' },
      { outcome: 'denied', message: 'not allowed' },
      { outcome: 'validation_failed', message: 'bad request' },
      { outcome: 'conflict' },
      { outcome: 'error' },
    ]
    for (const outcome of outcomes) {
      const hook: PublicRouteHooks = { onPublicRouteRequest: () => Promise.resolve(outcome) }
      const result = await hook.onPublicRouteRequest(baseRequest())
      expect(result).toEqual(outcome)
    }
  })

  it('receives only plain, serializable data — method/pathTemplate/params/query, no session/context', async () => {
    let seenRequest: PublicRouteRequest | undefined
    const hook: PublicRouteHooks = {
      onPublicRouteRequest: (request) => {
        seenRequest = request
        return Promise.resolve({ outcome: 'response', status: 200 })
      },
    }
    await hook.onPublicRouteRequest(
      baseRequest({ params: { token: 'xyz' }, query: { foo: 'bar' } })
    )
    expect(seenRequest).toEqual({
      method: 'GET',
      pathTemplate: '/redeem/:token',
      params: { token: 'xyz' },
      query: { foo: 'bar' },
    })
    // No `body` field exists on the type in v1 (Design Decision C) — verified structurally by the
    // exact-equality assertion above (an extra field would fail it).
  })

  it('a response result may omit headers/body entirely (both optional)', async () => {
    const hook: PublicRouteHooks = {
      onPublicRouteRequest: () => Promise.resolve({ outcome: 'response', status: 404 }),
    }
    const result = await hook.onPublicRouteRequest(baseRequest())
    expect(result).toEqual({ outcome: 'response', status: 404 })
  })
})
