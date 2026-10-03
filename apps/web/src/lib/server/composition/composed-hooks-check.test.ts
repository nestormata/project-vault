// Code review 68-6 — `checkComposedHooks` runs every module-init composition of the three hook
// contribution modules (what hooks.server.ts, hooks.ts and hooks.client.ts do at start-up) and
// returns the header-policy delta notes (AC-6/Q3). composed-hooks-init.test.ts runs it over the
// real virtual modules; these cases prove each failure surfaces.
import { describe, expect, it } from 'vitest'
import { EMPTY_CONTRIBUTED_PATHS } from '$lib/server/protected-paths.js'
import { checkComposedHooks } from './composed-hooks-check.js'

const empty = { server: {}, protectedPaths: EMPTY_CONTRIBUTED_PATHS, universal: {}, client: {} }

describe('checkComposedHooks (code review 68-6)', () => {
  it('empty contributions: no notes', () => {
    expect(checkComposedHooks(empty)).toEqual({ notes: [] })
  })

  it('a protected set covering a guard redirect target fails (redirect loop)', () => {
    expect(() =>
      checkComposedHooks({
        ...empty,
        protectedPaths: { routeIds: ['/(app)/login'], add: [], remove: [] },
      })
    ).toThrow('covers the guard redirect target /login (redirect loop)')
  })

  it('a handle wrap that does not return a function fails', () => {
    expect(() =>
      checkComposedHooks({ ...empty, server: { handle: { wrap: () => 'nope' } } })
    ).toThrow('wrap for "handle" must return a function')
  })

  it('a bad header policy, a bad hook shape and a transport collision fail', () => {
    expect(() =>
      checkComposedHooks({ ...empty, server: { headerPolicy: () => ({ defaults: {} }) } })
    ).toThrow('invalid header policy')
    expect(() => checkComposedHooks({ ...empty, server: { init: 'x' } })).toThrow(
      'hooks.server: export "init" must be a function or { wrap }'
    )
    expect(() => checkComposedHooks({ ...empty, client: { init: 1 } })).toThrow('hooks.client')
    expect(() => checkComposedHooks({ ...empty, universal: { reroute: 1 } })).toThrow(
      'hooks.universal'
    )
  })

  it('returns one note per header policy difference (recorded, never refused)', () => {
    const { notes } = checkComposedHooks({
      ...empty,
      server: {
        headerPolicy: (pv: { defaults: Record<string, string> }) => ({
          ...pv,
          defaults: { 'x-cm-policy': 'on' },
        }),
      },
    })
    expect(notes).toEqual([
      'header policy: added defaults.x-cm-policy',
      'header policy: removed defaults.content-security-policy',
      'header policy: removed defaults.x-frame-options',
    ])
  })
})
