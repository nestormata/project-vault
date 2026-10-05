import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit'
import { describe, expect, it, vi } from 'vitest'
import {
  createInjectBehavior,
  SKIP_INJECTED_LOADS,
  type BehaviorTables,
} from './inject-behavior.js'

// Story 68.4 AC-5 / AC-6 / AC-14: server load and action injection. The generated tables come from
// the kit; here they are handed in directly.

const event = { params: { projectId: 'p1' }, locals: { user: { userId: 'u1' } } } as never

const emptyBehavior = createInjectBehavior({ loads: {}, actions: {} })

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((done) => setTimeout(() => done(value), ms))
}

function tables(partial: Partial<BehaviorTables>): BehaviorTables {
  return { loads: {}, actions: {}, ...partial }
}

describe('empty BehaviorTables fixture: injection is a no-op', () => {
  it('injectLoad resolves to an empty object with no __inject key', async () => {
    const result = await emptyBehavior.injectLoad(event, '/(app)/projects/[projectId]', 'page')
    expect(result).toEqual({})
    expect('__inject' in result).toBe(false)
  })

  it('injectActions returns undefined, not {}, so Kit keeps its "no actions" 405 branch', () => {
    expect(emptyBehavior.injectActions('/(app)/projects/[projectId]')).toBeUndefined()
    expect({ ...{ own: 1 }, ...emptyBehavior.injectActions('/x') }).toEqual({ own: 1 })
  })
})

describe('injectLoad', () => {
  it('runs every load of the (route, scope) slice, aligned to contributions, with the same event', async () => {
    const seen: unknown[] = []
    const { injectLoad: run } = createInjectBehavior(
      tables({
        loads: {
          '/r#page': [
            {
              point: 'a.b.after',
              contributions: [
                { order: 10, load: (e: unknown) => (seen.push(e), { healthy: 3 }) },
                { order: 20, load: null },
                { order: 30, load: () => undefined },
              ],
            },
          ],
        },
      })
    )
    const result = await run(event, '/r', 'page')
    expect(result).toEqual({ __inject: { 'a.b.after': [{ healthy: 3 }, null, null] } })
    expect(seen[0]).toBe(event)
    // another scope or route never runs here
    expect(await run(event, '/r', 'layout')).toEqual({})
    expect(await run(event, '/other', 'page')).toEqual({})
  })

  it('treats null, primitives and arrays as entries as returned', async () => {
    const { injectLoad: run } = createInjectBehavior(
      tables({
        loads: {
          '/r#page': [
            {
              point: 'a.b.c',
              contributions: [
                { order: 0, load: () => null },
                { order: 1, load: () => 5 },
                { order: 2, load: () => [1] },
              ],
            },
          ],
        },
      })
    )
    expect(await run(event, '/r', 'page')).toEqual({ __inject: { 'a.b.c': [null, 5, [1]] } })
  })

  it('runs loads concurrently and keeps declaration order regardless of completion order', async () => {
    const { injectLoad: run } = createInjectBehavior(
      tables({
        loads: {
          '/r#page': [
            {
              point: 'a.b.c',
              contributions: [
                { order: 1, load: () => delay(50, 'slow') },
                { order: 2, load: () => delay(10, 'fast') },
              ],
            },
            { point: 'a.b.d', contributions: [{ order: 1, load: () => delay(30, 'mid') }] },
          ],
        },
      })
    )
    const started = Date.now()
    for (let i = 0; i < 3; i += 1) {
      expect(await run(event, '/r', 'page')).toEqual({
        __inject: { 'a.b.c': ['slow', 'fast'], 'a.b.d': ['mid'] },
      })
    }
    expect(Date.now() - started).toBeLessThan(3 * 50 + 120)
  })

  it('passes redirect() and error() through untouched', async () => {
    const make = (thrower: () => never) =>
      createInjectBehavior(
        tables({
          loads: { '/r#page': [{ point: 'a.b.c', contributions: [{ order: 0, load: thrower }] }] },
        })
      ).injectLoad
    await expect(make(() => redirect(303, '/login'))(event, '/r', 'page')).rejects.toMatchObject({
      status: 303,
      location: '/login',
    })
    await expect(make(() => error(404, 'gone'))(event, '/r', 'page')).rejects.toMatchObject({
      status: 404,
    })
  })

  it('wraps any other throw with the point and the error NAME only, keeping the cause', async () => {
    const secret = new TypeError('password=hunter2')
    const { injectLoad: run } = createInjectBehavior(
      tables({
        loads: {
          '/r#page': [
            {
              point: 'project.detail.after',
              contributions: [
                {
                  order: 0,
                  load: () => {
                    throw secret
                  },
                },
              ],
            },
          ],
        },
      })
    )
    const failure = (await run(event, '/r', 'page').catch((e: unknown) => e)) as Error
    expect(failure.message).toBe('injection "project.detail.after" load failed: TypeError')
    expect(failure.cause).toBe(secret)
    expect(failure.message).not.toContain('hunter2')
  })

  it('uses NonError for a thrown string/object/null and cuts a long error name to 64 characters', async () => {
    const run = (thrown: unknown) =>
      createInjectBehavior(
        tables({
          loads: {
            '/r#page': [
              {
                point: 'a.b.c',
                contributions: [
                  {
                    order: 0,
                    load: () => {
                      throw thrown
                    },
                  },
                ],
              },
            ],
          },
        })
      ).injectLoad(event, '/r', 'page')
    for (const thrown of ['boom', { name: 'Evil' }, null]) {
      await expect(run(thrown)).rejects.toThrow('injection "a.b.c" load failed: NonError')
    }
    const long = new Error('x')
    long.name = 'N'.repeat(100)
    await expect(run(long)).rejects.toThrow(`load failed: ${'N'.repeat(64)}`)
  })

  it('awaits every load to settlement and rethrows the failure of the LOWEST order, deterministically', async () => {
    const settled: string[] = []
    const make = (fastFirst: boolean) =>
      createInjectBehavior(
        tables({
          loads: {
            '/r#page': [
              {
                point: 'a.b.c',
                contributions: [
                  {
                    order: 20,
                    load: async () => {
                      await delay(fastFirst ? 5 : 40, null)
                      settled.push('high')
                      throw error(500, 'high')
                    },
                  },
                  {
                    order: 10,
                    load: async () => {
                      await delay(fastFirst ? 40 : 5, null)
                      settled.push('low')
                      throw redirect(303, '/low')
                    },
                  },
                ],
              },
            ],
          },
        })
      ).injectLoad
    for (const fastFirst of [true, false, true, false]) {
      settled.length = 0
      await expect(make(fastFirst)(event, '/r', 'page')).rejects.toMatchObject({
        location: '/low',
      })
      expect(settled).toHaveLength(2)
    }
  })

  it('shares no state between interleaved requests of two users', async () => {
    const { injectLoad: run } = createInjectBehavior(
      tables({
        loads: {
          '/r#page': [
            {
              point: 'a.b.c',
              contributions: [
                {
                  order: 0,
                  load: async (e: unknown) => {
                    await delay(Math.random() * 10, null)
                    return (e as { locals: { user: string } }).locals.user
                  },
                },
              ],
            },
          ],
        },
      })
    )
    const users = Array.from({ length: 20 }, (_, i) => `user-${i % 2}`)
    const results = await Promise.all(
      users.map((user) => run({ locals: { user } } as never, '/r', 'page'))
    )
    expect(results).toEqual(users.map((user) => ({ __inject: { 'a.b.c': [user] } })))
  })

  it('makes no network call and logs nothing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await emptyBehavior.injectLoad(event, '/anything', 'layout')
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})

describe('injectActions', () => {
  const action = (run: (e: RequestEvent) => unknown) => ({
    '/r#page': {
      'credential.detail.after.share': { point: 'credential.detail.after', name: 'share', run },
    },
  })

  it('exposes <point>.<name> keys, runs with the same event and passes results and fail() through', async () => {
    const seen: unknown[] = []
    const actions = createInjectBehavior(
      tables({
        actions: action((e) => (seen.push(e), fail(422, { message: 'empty' }))),
      })
    ).injectActions('/r')
    expect(Object.keys(actions ?? {})).toEqual(['credential.detail.after.share'])
    const result = await actions?.['credential.detail.after.share']?.(event)
    expect(result).toMatchObject({ status: 422 })
    expect(seen[0]).toBe(event)
  })

  it('has no inherited keys: __proto__, constructor and toString never resolve', () => {
    const actions = createInjectBehavior(tables({ actions: action(() => 1) })).injectActions('/r')
    expect(Object.getPrototypeOf(actions)).toBeNull()
    expect(Object.isFrozen(actions)).toBe(true)
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(Reflect.get(actions ?? {}, key)).toBeUndefined()
    }
  })

  it('wraps a throwing action with the point, action and error name; redirects pass through', async () => {
    const throwing = createInjectBehavior(
      tables({
        actions: action(() => {
          throw new RangeError('secret detail')
        }),
      })
    ).injectActions('/r')
    await expect(throwing?.['credential.detail.after.share']?.(event)).rejects.toThrow(
      'injection "credential.detail.after" action "share" failed: RangeError'
    )
    const redirecting = createInjectBehavior(
      tables({
        actions: action(() => {
          throw redirect(303, '/done')
        }),
      })
    ).injectActions('/r')
    await expect(redirecting?.['credential.detail.after.share']?.(event)).rejects.toMatchObject({
      location: '/done',
    })
  })

  it('returns undefined for a route with no injected actions', () => {
    const { injectActions: run } = createInjectBehavior(tables({ actions: action(() => 1) }))
    expect(run('/other')).toBeUndefined()
    expect(
      createInjectBehavior(tables({ actions: { '/r#page': {} } })).injectActions('/r')
    ).toBeUndefined()
  })
})

describe("withInjectedLoad: PV's own load first, then the injected data", () => {
  it("is a no-op in PV's build: the own data comes back unchanged, with no __inject key", async () => {
    const wrapped = emptyBehavior.withInjectedLoad(async () => ({ user: 'u1' }), '/r', 'page')
    const result = await wrapped(event)
    expect(result).toEqual({ user: 'u1' })
    expect('__inject' in result).toBe(false)
  })

  it('merges the own data with the injected data, own load first, with the same event', async () => {
    const order: string[] = []
    const { withInjectedLoad: wrap } = createInjectBehavior({
      loads: {
        '/r#page': [
          {
            point: 'a.b.c',
            contributions: [{ order: 0, load: () => (order.push('injected'), 'extra') }],
          },
        ],
      },
      actions: {},
    })
    const wrapped = wrap(async (e: unknown) => (order.push('own'), { seen: e }), '/r', 'page')
    expect(await wrapped(event)).toEqual({ seen: event, __inject: { 'a.b.c': ['extra'] } })
    expect(order).toEqual(['own', 'injected'])
  })

  it("short-circuits when PV's own load redirects: no contribution load runs", async () => {
    let ran = 0
    const { withInjectedLoad: wrap } = createInjectBehavior({
      loads: {
        '/r#page': [{ point: 'a.b.c', contributions: [{ order: 0, load: () => (ran += 1) }] }],
      },
      actions: {},
    })
    const wrapped = wrap(
      () => {
        throw redirect(303, '/login')
      },
      '/r',
      'page'
    )
    await expect(wrapped(event)).rejects.toMatchObject({ status: 303 })
    expect(ran).toBe(0)
  })

  // Story 69.1 Q2 (DW-490 item 1): PV's own 404 result must not be turned into a 500 (or an existence
  // oracle) by a contribution load, so none runs for a `notFound: true` own result, and every point
  // of the slice still gets one null entry per contribution (alignment, no throw).
  describe('a notFound own result (Story 69.1)', () => {
    const counter = { ran: 0 }
    const sliceTables = (): BehaviorTables => ({
      loads: {
        '/r#page': [
          {
            point: 'a.b.tiles',
            contributions: [
              { order: 0, load: () => (counter.ran += 1) },
              { order: 1, load: null },
            ],
          },
          { point: 'a.b.after', contributions: [{ order: 0, load: () => (counter.ran += 1) }] },
        ],
      },
      actions: {},
    })

    it('runs no contribution load and returns a null entry per contribution, own data intact', async () => {
      counter.ran = 0
      const { withInjectedLoad: wrap } = createInjectBehavior(sliceTables())
      const own = { project: null, notFound: true as const }
      const result = await wrap(async () => own, '/r', 'page')(event)
      expect(counter.ran).toBe(0)
      expect(result).toEqual({
        project: null,
        notFound: true,
        __inject: { 'a.b.tiles': [null, null], 'a.b.after': [null] },
      })
    })

    it.each([[{ notFound: false }], [{ notFound: 'true' }], [{ project: null }]])(
      'only a literal true skips: %j still runs the loads',
      async (own) => {
        const { withInjectedLoad: wrap } = createInjectBehavior(sliceTables())
        counter.ran = 0
        await wrap(async () => own, '/r', 'page')(event)
        expect(counter.ran).toBe(2)
      }
    )

    it('skips for a layout slice too (the layout 404 result carries notFound: true)', async () => {
      counter.ran = 0
      const { withInjectedLoad: wrap } = createInjectBehavior({
        loads: {
          '/r#layout': [
            {
              point: 'a.layout.nav',
              contributions: [{ order: 0, load: () => (counter.ran += 1) }],
            },
          ],
        },
        actions: {},
      })
      const result = await wrap(
        async () => ({ project: null, notFound: true }),
        '/r',
        'layout'
      )(event)
      expect(counter.ran).toBe(0)
      expect(result).toMatchObject({ __inject: { 'a.layout.nav': [null] } })
    })

    it('adds nothing when the slice has no contributions (PV build shape is unchanged)', async () => {
      const { withInjectedLoad: wrap } = createInjectBehavior({ loads: {}, actions: {} })
      expect(await wrap(async () => ({ notFound: true }), '/r', 'page')(event)).toEqual({
        notFound: true,
      })
    })
  })

  // Story 69.3 AC-5.4 (Open Q2): the public status page answers an invalid, disabled or sealed token
  // with `statusPage: null` (no `notFound` shape). Its own load marks that result with the typed
  // `skipInjectedLoads: true`; the wrapper then runs no contribution load (a pack can build no
  // token-validity oracle) and strips the marker, so PV's own data shape is unchanged.
  describe('the skipInjectedLoads marker (Story 69.3)', () => {
    const counter = { ran: 0 }
    const sliceTables = (): BehaviorTables => ({
      loads: {
        '/s#page': [
          {
            point: 'status.detail.services',
            contributions: [
              { order: 0, load: () => (counter.ran += 1) },
              { order: 1, load: null },
            ],
          },
        ],
      },
      actions: {},
    })

    it('runs no load, aligns null entries and strips the marker from the returned data', async () => {
      counter.ran = 0
      const { withInjectedLoad: wrap } = createInjectBehavior(sliceTables())
      const result = await wrap(
        async () => ({ statusPage: null, skipInjectedLoads: true as const }),
        '/s',
        'page'
      )(event)
      expect(counter.ran).toBe(0)
      expect(result).toEqual({
        statusPage: null,
        __inject: { 'status.detail.services': [null, null] },
      })
      expect('skipInjectedLoads' in result).toBe(false)
    })

    it('a valid result (no marker) still runs the loads', async () => {
      counter.ran = 0
      const { withInjectedLoad: wrap } = createInjectBehavior(sliceTables())
      const result = await wrap(async () => ({ statusPage: { services: [] } }), '/s', 'page')(event)
      expect(counter.ran).toBe(1)
      expect(result).toEqual({
        statusPage: { services: [] },
        __inject: { 'status.detail.services': [1, null] },
      })
    })

    it.each([[{ skipInjectedLoads: false }], [{ skipInjectedLoads: 'true' }]])(
      'only a literal true skips: %j still runs the loads',
      async (own) => {
        counter.ran = 0
        const { withInjectedLoad: wrap } = createInjectBehavior(sliceTables())
        await wrap(async () => own, '/s', 'page')(event)
        expect(counter.ran).toBe(1)
      }
    )

    it('adds nothing but the strip when the slice has no contributions (PV build shape)', async () => {
      const { withInjectedLoad: wrap } = createInjectBehavior({ loads: {}, actions: {} })
      expect(
        await wrap(async () => ({ statusPage: null, skipInjectedLoads: true }), '/s', 'page')(event)
      ).toEqual({ statusPage: null })
    })

    it('a redirect or HttpError from the own load still passes through, no load runs', async () => {
      counter.ran = 0
      const { withInjectedLoad: wrap } = createInjectBehavior(sliceTables())
      await expect(
        wrap(
          async () => {
            throw redirect(303, '/login')
          },
          '/s',
          'page'
        )(event)
      ).rejects.toMatchObject({ status: 303 })
      expect(counter.ran).toBe(0)
    })

    it('a failing contribution wraps the error NAME only, never the token or params', async () => {
      const { withInjectedLoad: wrap } = createInjectBehavior({
        loads: {
          '/s#page': [
            {
              point: 'status.detail.services',
              contributions: [
                {
                  order: 0,
                  load: () => {
                    throw new TypeError('secret-token-value in message')
                  },
                },
              ],
            },
          ],
        },
        actions: {},
      })
      const publicEvent = { params: { token: 'secret-token-value' }, locals: {} } as never
      const failure = (await wrap(
        async () => ({ statusPage: { services: [] } }),
        '/s',
        'page'
      )(publicEvent).catch((reason: unknown) => reason)) as Error
      expect(failure.message).toBe('injection "status.detail.services" load failed: TypeError')
      expect(failure.message).not.toContain('secret-token-value')
    })
  })

  // Story 69.2 Q3 (widens 69.1's Q5 default): with the vault sealed every PV API call answers 503,
  // so a contribution that calls the API would turn PV's friendly sealed banner into a 500. A
  // `vaultSealed: true` own result therefore skips the contribution loads exactly like `notFound`,
  // with one null entry per contribution (alignment) and PV's own data intact.
  describe('a vaultSealed own result (Story 69.2)', () => {
    const counter = { ran: 0 }
    const sealedTables = (): BehaviorTables => ({
      loads: {
        '/r#page': [
          {
            point: 'credential.detail.shares',
            contributions: [
              {
                order: 0,
                load: () => {
                  counter.ran += 1
                  throw new Error('Service Unavailable')
                },
              },
              { order: 1, load: null },
            ],
          },
          { point: 'credential.detail.after', contributions: [{ order: 0, load: () => 1 }] },
        ],
      },
      actions: {},
    })

    it('runs no contribution load (a throwing one never fails the page) and keeps the alignment', async () => {
      counter.ran = 0
      const { withInjectedLoad: wrap } = createInjectBehavior(sealedTables())
      const own = { credential: null, vaultSealed: true as const }
      const result = await wrap(async () => own, '/r', 'page')(event)
      expect(counter.ran).toBe(0)
      expect(result).toEqual({
        credential: null,
        vaultSealed: true,
        __inject: { 'credential.detail.shares': [null, null], 'credential.detail.after': [null] },
      })
    })

    it.each([[{ vaultSealed: false }], [{ vaultSealed: 'true' }], [{ credential: null }]])(
      'only a literal true skips: %j still runs the loads',
      async (own) => {
        counter.ran = 0
        const { withInjectedLoad: wrap } = createInjectBehavior(sealedTables())
        await expect(wrap(async () => own, '/r', 'page')(event)).rejects.toMatchObject({
          message: 'injection "credential.detail.shares" load failed: Error',
        })
        expect(counter.ran).toBe(1)
      }
    )

    it('a notFound and a vaultSealed result share one skip predicate', async () => {
      counter.ran = 0
      const { withInjectedLoad: wrap } = createInjectBehavior(sealedTables())
      const results = await Promise.all(
        [{ notFound: true }, { vaultSealed: true }].map((own) =>
          wrap(async () => own, '/r', 'page')(event)
        )
      )
      for (const result of results) {
        expect(result).toMatchObject({ __inject: { 'credential.detail.after': [null] } })
      }
      expect(counter.ran).toBe(0)
    })
  })

  // Story 69.7 (DW-531): PV's own denial. A literal `allowed: false` is PV's own vocabulary on its
  // settings pages; the typed SKIP_INJECTED_LOADS marker covers denials with another shape.
  describe('a denied own result (Story 69.7)', () => {
    const counter = { ran: 0 }
    const deniedTables = (): BehaviorTables => ({
      loads: {
        '/d#page': [
          {
            point: 'settings.audit.results',
            contributions: [
              { order: 0, load: () => (counter.ran += 1) },
              { order: 1, load: null },
            ],
          },
        ],
        '/d#layout': [
          { point: 'layout.point', contributions: [{ order: 0, load: () => (counter.ran += 1) }] },
        ],
      },
      actions: {},
    })

    it('allowed:false runs no load, keeps null alignment and keeps allowed in the data', async () => {
      counter.ran = 0
      const { withInjectedLoad: wrap } = createInjectBehavior(deniedTables())
      const result = await wrap(
        async () => ({ orgRole: 'member', allowed: false }),
        '/d',
        'page'
      )(event)
      expect(counter.ran).toBe(0)
      expect(result).toEqual({
        orgRole: 'member',
        allowed: false,
        __inject: { 'settings.audit.results': [null, null] },
      })
    })

    it('behaves the same for the layout scope', async () => {
      counter.ran = 0
      const { withInjectedLoad: wrap } = createInjectBehavior(deniedTables())
      const result = await wrap(async () => ({ allowed: false }), '/d', 'layout')(event)
      expect(counter.ran).toBe(0)
      expect(result).toEqual({ allowed: false, __inject: { 'layout.point': [null] } })
    })

    it.each([[{ allowed: true }], [{ allowed: 'false' }], [{ allowed: 0 }], [{}], [undefined]])(
      'runs the loads for %j (only the literal false is a denial)',
      async (own) => {
        counter.ran = 0
        const { withInjectedLoad: wrap } = createInjectBehavior(deniedTables())
        await wrap(async () => own, '/d', 'page')(event)
        expect(counter.ran).toBe(1)
      }
    )

    it('SKIP_INJECTED_LOADS skips the loads and is stripped from the data', async () => {
      counter.ran = 0
      const { withInjectedLoad: wrap } = createInjectBehavior(deniedTables())
      const result = await wrap(
        async () => ({ members: [], ...SKIP_INJECTED_LOADS }),
        '/d',
        'page'
      )(event)
      expect(counter.ran).toBe(0)
      expect('skipInjectedLoads' in result).toBe(false)
      expect(SKIP_INJECTED_LOADS).toEqual({ skipInjectedLoads: true })
    })

    it('a redirect still short-circuits before the denial check', async () => {
      counter.ran = 0
      const { withInjectedLoad: wrap } = createInjectBehavior(deniedTables())
      await expect(
        wrap(
          async () => {
            redirect(303, '/login')
          },
          '/d',
          'page'
        )(event)
      ).rejects.toMatchObject({ status: 303 })
      expect(counter.ran).toBe(0)
    })

    it('two parallel requests, one denied and one allowed: only the allowed one calls the load', async () => {
      counter.ran = 0
      const { withInjectedLoad: wrap } = createInjectBehavior(deniedTables())
      await Promise.all([
        wrap(async () => ({ allowed: false }), '/d', 'page')(event),
        wrap(async () => ({ allowed: true }), '/d', 'page')(event),
      ])
      expect(counter.ran).toBe(1)
    })

    it('AC-11 gap pinned: an injected action still runs for a caller whose load PV denied (actions never see the load result)', async () => {
      const run = vi.fn(() => ({ ok: true }))
      const { injectActions: actionsOf } = createInjectBehavior({
        loads: {},
        actions: { '/d#page': { 'p.save': { point: 'p', name: 'save', run } } },
      })
      await actionsOf('/d')?.['p.save']?.(event)
      expect(run).toHaveBeenCalledOnce()
    })

    it("PV's own build (empty tables) returns the own data unchanged", async () => {
      const result = await emptyBehavior.withInjectedLoad(
        async () => ({ orgRole: 'member', allowed: false }),
        '/d',
        'page'
      )(event)
      expect(result).toEqual({ orgRole: 'member', allowed: false })
    })
  })

  it('keeps a standard point and a region point on one page aligned, each to its own contributions', async () => {
    const { withInjectedLoad: wrap } = createInjectBehavior({
      loads: {
        '/r#page': [
          {
            point: 'project.detail.after',
            contributions: [{ order: 0, load: () => 'after' }],
          },
          {
            point: 'project.detail.tiles',
            contributions: [
              { order: 0, load: null },
              { order: 1, load: () => 'tile' },
            ],
          },
        ],
      },
      actions: {},
    })
    expect(await wrap(() => ({}), '/r', 'page')(event)).toEqual({
      __inject: { 'project.detail.after': ['after'], 'project.detail.tiles': [null, 'tile'] },
    })
  })

  it('tolerates a PV load that returns nothing', async () => {
    const { withInjectedLoad: wrap } = createInjectBehavior({
      loads: {
        '/r#page': [{ point: 'a.b.c', contributions: [{ order: 0, load: () => 'extra' }] }],
      },
      actions: {},
    })
    expect(await wrap(() => undefined, '/r', 'page')(event)).toEqual({
      __inject: { 'a.b.c': ['extra'] },
    })
  })
})
