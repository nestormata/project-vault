import { describe, expect, it } from 'vitest'
import {
  bindRequestContext,
  bindRequestContextLifecycle,
  getRequestContext,
  runWithRequestContext,
} from './request-context.js'

/** Opens a request-context box the way `authenticate.ts`'s `onRequest` hook does, then runs
 * `fn` as if it were the rest of the request lifecycle (subsequent preHandlers + the route
 * handler) — without needing a real Fastify app. */
function withOpenBox<T>(fn: () => T | Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    bindRequestContextLifecycle(undefined, undefined, () => {
      Promise.resolve().then(fn).then(resolve, reject)
    })
  })
}

describe('request-context — AC1: ambient per-request context', () => {
  it('getRequestContext() returns undefined when called outside any bound request, and never throws', () => {
    expect(() => getRequestContext()).not.toThrow()
    expect(getRequestContext()).toBeUndefined()
  })

  it('runWithRequestContext() binds {orgId, userId} for the duration of the callback', async () => {
    const seen: Array<ReturnType<typeof getRequestContext>> = []

    await runWithRequestContext({ orgId: 'org-1', userId: 'user-1' }, async () => {
      seen.push(getRequestContext())
      await Promise.resolve()
      seen.push(getRequestContext())
    })

    expect(seen).toEqual([
      { orgId: 'org-1', userId: 'user-1' },
      { orgId: 'org-1', userId: 'user-1' },
    ])
  })

  it('the context is not visible after runWithRequestContext() returns', async () => {
    await runWithRequestContext({ orgId: 'org-1', userId: 'user-1' }, () => undefined)
    expect(getRequestContext()).toBeUndefined()
  })

  it("two concurrent runWithRequestContext() calls never see each other's context (AsyncLocalStorage isolation)", async () => {
    async function readAfterDelay(orgId: string, userId: string, delayMs: number) {
      return runWithRequestContext({ orgId, userId }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        return getRequestContext()
      })
    }

    const [a, b] = await Promise.all([
      readAfterDelay('org-a', 'user-a', 10),
      readAfterDelay('org-b', 'user-b', 1),
    ])

    expect(a).toEqual({ orgId: 'org-a', userId: 'user-a' })
    expect(b).toEqual({ orgId: 'org-b', userId: 'user-b' })
  })
})

describe('request-context — AC2/AC9: the real Fastify shape (open-early box, mutate-later bind)', () => {
  it('getRequestContext() returns undefined once the box is open but before bindRequestContext() has populated it', async () => {
    const seenBeforeBind = await withOpenBox(() => getRequestContext())
    expect(seenBeforeBind).toBeUndefined()
  })

  it(
    'REGRESSION — bindRequestContext() called after an internal await (deep inside a nested ' +
      'async callee) is still visible to the OUTER caller once its own await resumes. This is ' +
      'the exact failure mode a bare enterWith() call at that point does NOT survive (see ' +
      "request-context.ts's module docstring): the outer caller's continuation was already " +
      "linked to the pre-bind async context before the callee's internal await ever ran.",
    async () => {
      async function nestedCalleeThatBindsAfterAnAwait() {
        await Promise.resolve()
        await Promise.resolve()
        bindRequestContext({ orgId: 'org-3', userId: 'user-3' })
      }

      const seenByOuterCaller = await withOpenBox(async () => {
        expect(getRequestContext()).toBeUndefined()
        await nestedCalleeThatBindsAfterAnAwait()
        // The outer caller's own `await` above resumes AFTER the nested callee's internal
        // awaits and its bindRequestContext() call — this is exactly the shape of Fastify
        // awaiting the `authenticate` preHandler and then moving on to the next stage.
        return getRequestContext()
      })

      expect(seenByOuterCaller).toEqual({ orgId: 'org-3', userId: 'user-3' })
    }
  )

  it('a value bound via bindRequestContext() is visible to a LATER, sibling continuation within the same open box (simulating the next preHandler/handler stage)', async () => {
    let seenBySiblingStage: ReturnType<typeof getRequestContext>

    await withOpenBox(async () => {
      bindRequestContext({ orgId: 'org-4', userId: 'user-4' })
      await Promise.resolve()
      seenBySiblingStage = getRequestContext()
    })

    expect(seenBySiblingStage).toEqual({ orgId: 'org-4', userId: 'user-4' })
  })

  it("two concurrent open boxes never see each other's bound context, even with interleaved binds", async () => {
    async function boundValue(orgId: string, userId: string, delayMs: number) {
      return withOpenBox(async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        bindRequestContext({ orgId, userId })
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        return getRequestContext()
      })
    }

    const [a, b] = await Promise.all([
      boundValue('org-a', 'user-a', 10),
      boundValue('org-b', 'user-b', 1),
    ])

    expect(a).toEqual({ orgId: 'org-a', userId: 'user-a' })
    expect(b).toEqual({ orgId: 'org-b', userId: 'user-b' })
  })

  it('bindRequestContext() falls back to binding a fresh context for the synchronous remainder when called with no box open at all', () => {
    expect(getRequestContext()).toBeUndefined()
    bindRequestContext({ orgId: 'org-5', userId: 'user-5' })
    expect(getRequestContext()).toEqual({ orgId: 'org-5', userId: 'user-5' })
  })
})
