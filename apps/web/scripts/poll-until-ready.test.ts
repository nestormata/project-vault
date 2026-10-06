// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pollUntilOk } from '../e2e/fixtures/poll-until-ready.js'

/**
 * Story 66.4: characterises the shared `pollUntilOk` retry helper (global-setup readiness and the
 * isolated-stack `/health` wait), including the AC-7 abort path.
 */

const URL_UNDER_TEST = 'http://poll.test/health'

function respondWith(...statuses: Array<number | Error>) {
  const fetchMock = vi.fn(async () => {
    const next = statuses.shift()
    if (next === undefined) throw new Error('fetch called more times than scripted')
    if (next instanceof Error) throw next
    return new Response(null, { status: next })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const exhausted = (lastError: unknown) =>
  new Error(`exhausted: ${lastError instanceof Error ? lastError.message : String(lastError)}`)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pollUntilOk', () => {
  it('resolves as soon as the URL answers ok', async () => {
    const fetchMock = respondWith(503, new Error('ECONNREFUSED'), 200)

    await expect(
      pollUntilOk(URL_UNDER_TEST, { attempts: 5, delayMs: 1, onExhausted: exhausted })
    ).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('throws onExhausted with the last error after exactly `attempts` polls', async () => {
    const fetchMock = respondWith(new Error('ECONNREFUSED'), 500, 503)

    await expect(
      pollUntilOk(URL_UNDER_TEST, { attempts: 3, delayMs: 1, onExhausted: exhausted })
    ).rejects.toThrow(`exhausted: ${URL_UNDER_TEST} responded with 503`)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('throws onExhausted(undefined) without polling when attempts is 0', async () => {
    const fetchMock = respondWith()

    await expect(
      pollUntilOk(URL_UNDER_TEST, { attempts: 0, delayMs: 1, onExhausted: exhausted })
    ).rejects.toThrow('exhausted: undefined')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resolves quietly without polling when the signal is already aborted', async () => {
    const fetchMock = respondWith()
    const controller = new AbortController()
    controller.abort()

    await expect(
      pollUntilOk(URL_UNDER_TEST, {
        attempts: 3,
        delayMs: 1,
        onExhausted: exhausted,
        signal: controller.signal,
      })
    ).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stops mid-delay and resolves quietly when the signal aborts between polls', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async () => {
      // A macrotask: runs after the poll has entered its (60 s) delay, never before.
      setImmediate(() => controller.abort())
      return new Response(null, { status: 503 })
    })
    vi.stubGlobal('fetch', fetchMock)

    // No elapsed-time assertion (Story 66-17): if the abort did not interrupt the 60 s delay this
    // promise would never settle and the test would hit its own timeout.
    await expect(
      pollUntilOk(URL_UNDER_TEST, {
        attempts: 3,
        delayMs: 60_000,
        onExhausted: exhausted,
        signal: controller.signal,
      })
    ).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('handles a long retry budget without growing the stack', async () => {
    const statuses: number[] = Array.from({ length: 499 }, () => 503)
    statuses.push(200)
    const fetchMock = respondWith(...statuses)

    await expect(
      pollUntilOk(URL_UNDER_TEST, { attempts: 500, delayMs: 0, onExhausted: exhausted })
    ).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(500)
  })
})
