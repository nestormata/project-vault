import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  runSearchProvider,
  type SearchProvider,
  type SearchProviderResult,
} from './search-providers.svelte.js'
import { path } from '$lib/navigation/nav-render-test-helpers.js'

const result: SearchProviderResult = {
  id: 'r1',
  label: 'Acme tenant',
  group: 'Tenants',
  href: path('/t/1'),
}

function provider(search: SearchProvider['search'], timeoutMs?: number): SearchProvider {
  return { id: 'p1', search, ...(timeoutMs === undefined ? {} : { timeoutMs }) }
}

describe('runSearchProvider (Story 72.18)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('returns the provider results, passing the query and a signal', async () => {
    const search = vi.fn(async () => [result])
    const outcome = await runSearchProvider(provider(search), 'acme', new AbortController().signal)
    expect(outcome).toEqual({ status: 'ok', results: [result] })
    expect(search).toHaveBeenCalledWith('acme', { signal: expect.any(AbortSignal) })
  })

  it('a rejecting provider is a calm failure, never a rejection', async () => {
    const outcome = await runSearchProvider(
      provider(async () => {
        throw new Error('boom')
      }),
      'acme',
      new AbortController().signal
    )
    expect(outcome).toEqual({ status: 'failed' })
  })

  it('a provider that throws synchronously is a failure too', async () => {
    const outcome = await runSearchProvider(
      provider(() => {
        throw new Error('sync boom')
      }),
      'acme',
      new AbortController().signal
    )
    expect(outcome).toEqual({ status: 'failed' })
  })

  it('a provider that never settles times out, and its signal is aborted', async () => {
    let seen: AbortSignal | undefined
    const pending = runSearchProvider(
      provider((_query, { signal }) => {
        seen = signal
        return new Promise<never>(() => {})
      }),
      'acme',
      new AbortController().signal
    )
    await vi.advanceTimersByTimeAsync(DEFAULT_PROVIDER_TIMEOUT_MS)
    expect(await pending).toEqual({ status: 'failed' })
    expect(seen?.aborted).toBe(true)
  })

  it('honours the provider timeoutMs', async () => {
    const pending = runSearchProvider(
      provider(() => new Promise<never>(() => {}), 50),
      'acme',
      new AbortController().signal
    )
    await vi.advanceTimersByTimeAsync(50)
    expect(await pending).toEqual({ status: 'failed' })
  })

  it('an aborted query settles as aborted, not failed', async () => {
    const controller = new AbortController()
    const pending = runSearchProvider(
      provider(() => new Promise<never>(() => {})),
      'acme',
      controller.signal
    )
    controller.abort()
    expect(await pending).toEqual({ status: 'aborted' })
  })

  it('an already aborted query never calls the provider', async () => {
    const controller = new AbortController()
    controller.abort()
    const search = vi.fn(async () => [result])
    expect(await runSearchProvider(provider(search), 'acme', controller.signal)).toEqual({
      status: 'aborted',
    })
    expect(search).not.toHaveBeenCalled()
  })

  it('drops malformed results and keeps the valid ones', async () => {
    const action = vi.fn()
    const outcome = await runSearchProvider(
      provider(
        async () =>
          [
            result,
            { id: 'a', label: 'Do it', group: 'Actions', action },
            { id: 'x', label: 'no target', group: 'Tenants' },
            { id: 'y', group: 'Tenants', href: '/y' },
            { id: 'z', label: 'both', group: 'Tenants', href: '/z', action },
            { id: 'e1', label: 'external', group: 'Tenants', href: 'https://evil.example' },
            { id: 'e2', label: 'proto-relative', group: 'Tenants', href: '//evil.example' },
            { id: 'e3', label: 'script', group: 'Tenants', href: 'javascript:alert(1)' },
            { id: 'r1', label: 'duplicate id', group: 'Tenants', href: '/dup' },
            null,
            'text',
          ] as unknown as SearchProviderResult[]
      ),
      'acme',
      new AbortController().signal
    )
    expect(outcome.status).toBe('ok')
    if (outcome.status === 'ok') expect(outcome.results.map((r) => r.id)).toEqual(['r1', 'a'])
  })

  it('a non-array answer is a failure', async () => {
    const outcome = await runSearchProvider(
      provider(async () => 'nope' as unknown as SearchProviderResult[]),
      'acme',
      new AbortController().signal
    )
    expect(outcome).toEqual({ status: 'failed' })
  })
})
