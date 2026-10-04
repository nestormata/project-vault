import { fail, redirect } from '@sveltejs/kit'
import { describe, expect, it } from 'vitest'
import {
  createInjectBehavior,
  type BehaviorTables,
} from '$lib/server/composition/inject-behavior.js'
import { actions } from './+page.server.js'

// Story 69.2 AC-4, AC-6, AC-7: behavior injection for the credential detail page's region points,
// proven against the generated-table shape the kit produces (the real server file is wrapped with an
// empty table in PV's own build, so the mechanism is exercised through `createInjectBehavior`).

const ROUTE = '/(app)/projects/[projectId]/credentials/[credentialId]'
const event = {
  params: { projectId: 'p1', credentialId: 'c1' },
  url: new URL('https://vault.example.com/projects/p1/credentials/c1?sharesStatus=active'),
  locals: { user: { userId: 'u1' } },
} as never

const noop = () => null

function tables(partial: Partial<BehaviorTables>): BehaviorTables {
  return { loads: {}, actions: {}, ...partial }
}

describe('the credential page server file in PV own build', () => {
  it('exports no actions at all: `undefined`, never `{}`, so a stray POST keeps its 405', () => {
    expect(actions).toBeUndefined()
  })
})

describe('region point behavior on the credential detail page', () => {
  const sharesLoad = {
    point: 'credential.detail.shares',
    contributions: [
      {
        order: 0,
        load: (e: { params: Record<string, string>; url: URL }) => ({
          projectId: e.params.projectId,
          credentialId: e.params.credentialId,
          status: e.url.searchParams.get('sharesStatus'),
        }),
      },
    ],
  }

  it('runs a region load with the request params and url and aligns it to its own point', async () => {
    const { withInjectedLoad } = createInjectBehavior(
      tables({
        loads: {
          [`${ROUTE}#page`]: [
            sharesLoad,
            { point: 'credential.detail.after', contributions: [{ order: 0, load: null }] },
          ],
        },
      })
    )
    const result = await withInjectedLoad(
      async () => ({ credential: { id: 'c1' } }),
      ROUTE,
      'page'
    )(event)
    expect(result).toEqual({
      credential: { id: 'c1' },
      __inject: {
        'credential.detail.shares': [{ projectId: 'p1', credentialId: 'c1', status: 'active' }],
        'credential.detail.after': [null],
      },
    })
  })

  it('exposes actions of two region points on the one page key, namespaced by point', () => {
    const action = (point: string, name: string) => ({
      point,
      name,
      run: () => ({ ok: point }),
    })
    const { injectActions } = createInjectBehavior(
      tables({
        actions: {
          [`${ROUTE}#page`]: {
            'credential.detail.shares.create': action('credential.detail.shares', 'create'),
            'credential.detail.shares.revoke': action('credential.detail.shares', 'revoke'),
            'credential.detail.actions.archive': action('credential.detail.actions', 'archive'),
          },
        },
      })
    )
    expect(Object.keys(injectActions(ROUTE) ?? {}).sort()).toEqual([
      'credential.detail.actions.archive',
      'credential.detail.shares.create',
      'credential.detail.shares.revoke',
    ])
  })

  it('keeps a contribution for the detail page off its sub-routes (separate route ids)', async () => {
    const { injectLoad, injectActions } = createInjectBehavior(
      tables({
        loads: { [`${ROUTE}#page`]: [sharesLoad] },
        actions: {
          [`${ROUTE}#page`]: {
            'credential.detail.shares.create': { point: 'p', name: 'create', run: noop },
          },
        },
      })
    )
    for (const sub of [`${ROUTE}/rotate`, `${ROUTE}/rotations/[rotationId]`]) {
      expect(await injectLoad(event, sub, 'page')).toEqual({})
      expect(injectActions(sub)).toBeUndefined()
    }
  })

  it('a denied action result (fail 403) is the action result, unchanged', async () => {
    const { injectActions } = createInjectBehavior(
      tables({
        actions: {
          [`${ROUTE}#page`]: {
            'credential.detail.shares.revoke': {
              point: 'credential.detail.shares',
              name: 'revoke',
              run: () => fail(403, { error: 'not the sharer' }),
            },
          },
        },
      })
    )
    const result = await injectActions(ROUTE)?.['credential.detail.shares.revoke']?.(event)
    expect(result).toMatchObject({ status: 403, data: { error: 'not the sharer' } })
  })

  it('a thrown redirect from a region load passes through untouched', async () => {
    const { withInjectedLoad } = createInjectBehavior(
      tables({
        loads: {
          [`${ROUTE}#page`]: [
            {
              point: 'credential.detail.shares',
              contributions: [
                {
                  order: 0,
                  load: () => {
                    redirect(303, '/login')
                  },
                },
              ],
            },
          ],
        },
      })
    )
    await expect(
      withInjectedLoad(async () => ({ credential: null }), ROUTE, 'page')(event)
    ).rejects.toMatchObject({ status: 303, location: '/login' })
  })

  it('a throwing region load fails the page with the point and the error NAME only', async () => {
    class SecretLeakError extends Error {
      constructor() {
        super('token=SHOULD-NEVER-BE-LOGGED')
        this.name = 'SecretLeakError'
      }
    }
    const { withInjectedLoad } = createInjectBehavior(
      tables({
        loads: {
          [`${ROUTE}#page`]: [
            {
              point: 'credential.detail.shares',
              contributions: [
                {
                  order: 0,
                  load: () => {
                    throw new SecretLeakError()
                  },
                },
              ],
            },
          ],
        },
      })
    )
    const failure = await withInjectedLoad(
      async () => ({ credential: { id: 'c1' } }),
      ROUTE,
      'page'
    )(event).then(
      () => null,
      (error: unknown) => error as Error
    )
    expect(failure?.message).toBe(
      'injection "credential.detail.shares" load failed: SecretLeakError'
    )
    expect(failure?.message).not.toContain('SHOULD-NEVER-BE-LOGGED')
    expect(failure?.cause).toBeInstanceOf(SecretLeakError)
  })

  it('re-running the page load (invalidateAll after a PV archive) re-runs the contribution load', async () => {
    let runs = 0
    const { withInjectedLoad } = createInjectBehavior(
      tables({
        loads: {
          [`${ROUTE}#page`]: [
            {
              point: 'credential.detail.shares',
              contributions: [{ order: 0, load: () => ({ run: (runs += 1) }) }],
            },
          ],
        },
      })
    )
    const load = withInjectedLoad(async () => ({ credential: { id: 'c1' } }), ROUTE, 'page')
    await load(event)
    const second = await load(event)
    expect(runs).toBe(2)
    expect(second.__inject['credential.detail.shares']).toEqual([{ run: 2 }])
  })

  it('does not run a contribution load for a notFound or a vaultSealed own result', async () => {
    let runs = 0
    const { withInjectedLoad } = createInjectBehavior(
      tables({
        loads: {
          [`${ROUTE}#page`]: [
            {
              point: 'credential.detail.shares',
              contributions: [{ order: 0, load: () => (runs += 1) }],
            },
          ],
        },
      })
    )
    for (const own of [
      { credential: null, notFound: true },
      { credential: null, notFound: false, vaultSealed: true },
    ]) {
      const result = await withInjectedLoad(async () => own, ROUTE, 'page')(event)
      expect(result.__inject).toEqual({ 'credential.detail.shares': [null] })
    }
    expect(runs).toBe(0)
  })
})

describe('the web app keeps the framework origin check (AC-4 red-team (c))', () => {
  it('sets no `csrf` override in svelte.config.js, so a forged-origin POST is rejected by Kit', async () => {
    const config = (await import('../../../../../../../svelte.config.js')) as {
      default: { kit?: Record<string, unknown> }
    }
    expect(config.default.kit).toBeDefined()
    expect(Object.keys(config.default.kit ?? {})).not.toContain('csrf')
  })
})
