// Story 68.6 AC-2 — the contribution contract for every non-`handle` hook: a chain entry
// ("CM first, then PV") or `{ wrap }`, `undefined` when neither side defines the hook.
import { describe, expect, it, vi } from 'vitest'
import { composeChainHook, readHandleContribution } from './hook-chain.js'

type Fn = (...args: never[]) => unknown
const call = (fn: unknown, ...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args)

describe('shape detection (AC-2)', () => {
  const bad: Array<[string, unknown, string]> = [
    ['a string', 'x', 'string'],
    ['a number', 1, 'number'],
    ['null', null, 'null'],
    ['an array', [], 'array'],
    ['an object with unknown keys only', { foo: 1 }, 'object with keys foo'],
    ['an object whose wrap is not a function', { wrap: 1 }, 'object with keys wrap'],
  ]
  for (const [label, value, got] of bad) {
    it(`rejects ${label} at module init`, () => {
      expect(() => composeChainHook('server', 'init', undefined, value)).toThrow(
        `hooks.server: export "init" must be a function or { wrap } (got ${got})`
      )
    })
  }

  it('handle accepts a function (one before entry) or { before, after, wrap }', () => {
    const h = vi.fn()
    expect(readHandleContribution(h)).toEqual({ before: [h], after: [], wrap: undefined })
    const w = (pv: Fn) => pv
    expect(readHandleContribution({ before: [h], after: [h], wrap: w })).toEqual({
      before: [h],
      after: [h],
      wrap: w,
    })
    expect(readHandleContribution(undefined)).toEqual({ before: [], after: [], wrap: undefined })
  })

  it('handle rejects unknown keys, non-array before/after and non-function entries', () => {
    expect(() => readHandleContribution({ befor: [] })).toThrow(
      'hooks.server: export "handle" must be a function or { before?, after?, wrap? } (got object with keys befor)'
    )
    expect(() => readHandleContribution({ before: 'x' })).toThrow(
      'hooks.server: export "handle" before must be an array of functions'
    )
    expect(() => readHandleContribution({ after: [1] })).toThrow(
      'hooks.server: export "handle" after must be an array of functions'
    )
    expect(() => readHandleContribution({ wrap: 'x' })).toThrow(
      'hooks.server: export "handle" wrap must be a function'
    )
    expect(() => readHandleContribution(7)).toThrow('(got number)')
  })
})

describe('neither PV nor CM (AC-2, Q7): the export stays undefined so Kit defaults run', () => {
  for (const name of [
    'handleError',
    'handleValidationError',
    'init',
    'handleFetch',
    'reroute',
    'transport',
  ]) {
    it(`${name} -> undefined`, () => {
      expect(composeChainHook('server', name, undefined, undefined)).toBeUndefined()
    })
  }

  it('PV only: PV hook unchanged (identity)', () => {
    const pv = vi.fn()
    expect(composeChainHook('client', 'handleError', pv, undefined)).toBe(pv)
  })

  it('throws for a name that is not a chain hook (programming error)', () => {
    expect(() => composeChainHook('server', 'nope', undefined, vi.fn())).toThrow(
      'no chain semantics for hook "nope"'
    )
  })
})

describe('handleError: C then P, awaited in order; C result wins unless undefined', () => {
  it('runs both in order and returns C when C returns a value', async () => {
    const order: string[] = []
    const composed = composeChainHook(
      'server',
      'handleError',
      async () => {
        order.push('P')
        return { message: 'p' }
      },
      async () => {
        order.push('C')
        return { message: 'c' }
      }
    )
    expect(await call(composed, {})).toEqual({ message: 'c' })
    expect(order).toEqual(['C', 'P'])
  })

  it('falls through to P when C returns undefined', async () => {
    const composed = composeChainHook(
      'client',
      'handleError',
      () => ({ message: 'p' }),
      () => undefined
    )
    expect(await call(composed, {})).toEqual({ message: 'p' })
  })

  it('CM only: the export is CM entry itself', () => {
    const c = vi.fn()
    expect(composeChainHook('server', 'handleError', undefined, c)).toBe(c)
  })

  it('a throwing C entry propagates and P does not run', async () => {
    const p = vi.fn()
    const boom = new Error('c failed')
    const composed = composeChainHook('server', 'handleError', p, () => {
      throw boom
    })
    await expect(async () => call(composed, {})).rejects.toBe(boom)
    expect(p).not.toHaveBeenCalled()
  })

  it('wrap receives a pv that returns undefined when PV has none', async () => {
    const composed = composeChainHook('server', 'handleError', undefined, {
      wrap: (pv: Fn) => async (input: unknown) => ({ pv: await call(pv, input) }),
    })
    expect(await call(composed, {})).toEqual({ pv: undefined })
  })
})

describe('handleValidationError: C then P; first non-undefined result', () => {
  it('C result short-circuits P', async () => {
    const p = vi.fn(() => ({ message: 'p' }))
    const composed = composeChainHook('server', 'handleValidationError', p, () => ({
      message: 'c',
    }))
    expect(await call(composed, {})).toEqual({ message: 'c' })
    expect(p).not.toHaveBeenCalled()
  })

  it('C undefined -> P', async () => {
    const composed = composeChainHook(
      'server',
      'handleValidationError',
      () => ({ message: 'p' }),
      () => undefined
    )
    expect(await call(composed, {})).toEqual({ message: 'p' })
  })
})

describe('init: C then P, awaited in order', () => {
  it('awaits C before running P', async () => {
    const order: string[] = []
    const composed = composeChainHook(
      'client',
      'init',
      () => {
        order.push('P')
      },
      async () => {
        await new Promise((r) => setTimeout(r, 5))
        order.push('C')
      }
    )
    await call(composed)
    expect(order).toEqual(['C', 'P'])
  })

  it('a rejecting C rejects the composed init', async () => {
    const composed = composeChainHook('server', 'init', vi.fn(), async () => {
      throw new Error('init failed')
    })
    await expect(async () => call(composed)).rejects.toThrow('init failed')
  })

  it('wrap: pv is a no-op when PV has none', async () => {
    const seen: unknown[] = []
    const composed = composeChainHook('server', 'init', undefined, {
      wrap: (pv: Fn) => async () => {
        seen.push(await call(pv))
      },
    })
    await call(composed)
    expect(seen).toEqual([undefined])
  })
})

describe('handleFetch: C runs with fetch = P bound to the real fetch', () => {
  it('C calling fetch goes through P, which calls the real fetch', async () => {
    const realFetch = vi.fn(async (req: Request) => new Response(req.headers.get('x-id')))
    const composed = composeChainHook(
      'server',
      'handleFetch',
      ({ request, fetch }: { request: Request; fetch: typeof globalThis.fetch }) => {
        const headers = new Headers(request.headers)
        headers.set('x-id', `${headers.get('x-id')}+pv`)
        return fetch(new Request(request, { headers }))
      },
      ({ request, fetch }: { request: Request; fetch: typeof globalThis.fetch }) =>
        fetch(new Request(request, { headers: { 'x-id': 'cm' } }))
    )
    const response = (await call(composed, {
      event: {},
      request: new Request('http://api.test/x'),
      fetch: realFetch,
    })) as Response
    expect(await response.text()).toBe('cm+pv')
  })

  it('CM only: C receives the real fetch', () => {
    const c = vi.fn()
    expect(composeChainHook('server', 'handleFetch', undefined, c)).toBe(c)
  })

  it('wrap: pv is a passthrough when PV has none', async () => {
    const realFetch = vi.fn(async () => new Response('real'))
    const composed = composeChainHook('server', 'handleFetch', undefined, {
      wrap: (pv: Fn) => (input: unknown) => call(pv, input),
    })
    const response = (await call(composed, {
      event: {},
      request: new Request('http://api.test/x'),
      fetch: realFetch,
    })) as Response
    expect(await response.text()).toBe('real')
  })
})

describe('reroute: C first; a string wins; undefined falls through to P', () => {
  it('C string wins', () => {
    const composed = composeChainHook(
      'universal',
      'reroute',
      () => '/p',
      ({ url }: { url: URL }) => (url.pathname === '/docs' ? '/cm/documents' : undefined)
    )
    expect(call(composed, { url: new URL('http://x/docs') })).toBe('/cm/documents')
    expect(call(composed, { url: new URL('http://x/other') })).toBe('/p')
  })

  it('stays synchronous when both entries are synchronous', () => {
    const composed = composeChainHook(
      'universal',
      'reroute',
      () => undefined,
      () => undefined
    )
    expect(call(composed, { url: new URL('http://x/') })).toBeUndefined()
  })

  it('awaits an async C', async () => {
    const composed = composeChainHook(
      'universal',
      'reroute',
      () => '/p',
      async () => undefined
    )
    expect(await call(composed, { url: new URL('http://x/') })).toBe('/p')
  })
})

describe('transport: { ...P, ...C }; a shared key fails at module init', () => {
  const money = { encode: () => false, decode: () => null }
  it('merges', () => {
    expect(composeChainHook('universal', 'transport', { A: money }, { Money: money })).toEqual({
      A: money,
      Money: money,
    })
  })

  it('a key in both fails (accidental collision)', () => {
    expect(() =>
      composeChainHook('universal', 'transport', { Money: money }, { Money: money })
    ).toThrow(
      'hooks.universal: transport type "Money" is defined by both PV and the contribution; use { wrap } to replace PV\'s'
    )
  })

  it('wrap may replace any key; pv is {} when PV has none', () => {
    const composed = composeChainHook('universal', 'transport', undefined, {
      wrap: (pv: object) => ({ ...pv, Money: money }),
    })
    expect(composed).toEqual({ Money: money })
  })

  it('a wrap that returns the wrong type fails at module init', () => {
    expect(() =>
      composeChainHook('universal', 'transport', undefined, { wrap: () => 'nope' })
    ).toThrow('hooks.universal: wrap for "transport" must return an object (got string)')
    expect(() => composeChainHook('server', 'init', undefined, { wrap: () => 1 })).toThrow(
      'hooks.server: wrap for "init" must return a function (got number)'
    )
  })
})

describe('wrap calling pv twice or never (AC-2 edge: pv is re-entrant)', () => {
  it('twice', async () => {
    const pv = vi.fn(() => undefined)
    const composed = composeChainHook('server', 'init', pv, {
      wrap: (p: Fn) => async () => {
        await call(p)
        await call(p)
      },
    })
    await call(composed)
    expect(pv).toHaveBeenCalledTimes(2)
  })

  it('never', async () => {
    const pv = vi.fn()
    const composed = composeChainHook('server', 'init', pv, { wrap: () => async () => undefined })
    await call(composed)
    expect(pv).not.toHaveBeenCalled()
  })
})
