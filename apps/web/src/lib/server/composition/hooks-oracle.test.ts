// Story 68.6 AC-5 — the whole-response oracle for PV's server `handle`. The snapshot was generated
// on `main` @ c4482a44 BEFORE any 68-6 change (the RED commit) and must stay byte-identical with
// no CM contribution. The single intended difference is AC-7's percent-encoded rows (Q5): on
// `main` they resolve without the hook's redirect; after 68-6 the route-id rule protects them.
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { describeResponse, fakeKitRequest } from './kit-request-test-helpers.js'

const getVaultReadinessMock = vi.hoisted(() => vi.fn())
const resolveAuthContextMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/vault.js', () => ({ getVaultReadiness: getVaultReadinessMock }))
vi.mock('$lib/server/auth-guard.js', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/auth-guard.js')>(
    '$lib/server/auth-guard.js'
  )
  return { ...actual, resolveAuthContext: resolveAuthContextMock }
})

import { handle } from '../../../hooks.server.js'

// Each path with the Kit route id it matches (`null` = no route), as Kit's `find_route` would set
// it on the DECODED path before `handle` runs.
const PATHS: ReadonlyArray<readonly [string, string | null]> = [
  ['/', '/'],
  ['/login', '/(auth)/login'],
  ['/register', '/(auth)/register'],
  ['/vault', '/(vault)/vault'],
  ['/dashboard', '/(app)/dashboard'],
  ['/dashboard/', null],
  ['/Dashboard', null],
  ['/dashboard/nope', null],
  ['/dashboardx', null],
  ['/projects/p1', '/(app)/projects/[projectId]'],
  ['/settings/notifications', '/(app)/settings/notifications'],
  ['/platform', '/(app)/platform'],
  ['/health', '/(app)/health'],
  ['/handoff', '/(auth)/handoff'],
  ['/handoff-admin', null],
  ['/handoff/x', null],
  ['/extensions/panels', null],
  ['/extensions/panels/group', '/(app)/extensions/panels/[slot]/[...subpath]'],
  ['/extensions/panels/group/a/b', '/(app)/extensions/panels/[slot]/[...subpath]'],
  ['/shares/tok', '/(app)/shares/[token]'],
  ['/external-shares/tok', '/external-shares/[token]'],
  ['/status/tok', '/status/[token]'],
  ['/api/v1/projects', '/api/v1/[...path]'],
  ['/api/health', '/api/health'],
  ['/ready', '/ready'],
  ['/nonexistent', null],
  ['/%64ashboard', '/(app)/dashboard'],
  ['/%73ettings/notifications', '/(app)/settings/notifications'],
]

type AuthCase = 'anonymous' | 'authenticated' | 'session-expired'
const AUTH_CASES: readonly AuthCase[] = ['anonymous', 'authenticated', 'session-expired']
const VAULT_CASES = ['ready', 'sealed'] as const

const COOKIES = new Map<AuthCase, string | null>([
  ['anonymous', null],
  ['authenticated', 'session=s1; PARAGLIDE_LOCALE=es'],
  ['session-expired', 'refresh-token=old'],
])

function mockAuth(auth: AuthCase) {
  resolveAuthContextMock.mockImplementation(
    async ({ forwardSetCookie }: { forwardSetCookie?: (value: string) => void }) => {
      switch (auth) {
        case 'authenticated':
          forwardSetCookie?.('access-token=renewed; Path=/; HttpOnly')
          return { status: 'authenticated', user: { id: 'u1', email: 'u1@example.test' } }
        case 'session-expired':
          forwardSetCookie?.('refresh-token=rotated; Path=/; HttpOnly')
          return { status: 'unauthenticated', reason: 'session-expired' }
        default:
          return { status: 'unauthenticated' }
      }
    }
  )
}

async function runCase(path: string, routeId: string | null, auth: AuthCase, vault: string) {
  getVaultReadinessMock.mockReset()
  getVaultReadinessMock.mockResolvedValue(
    vault === 'ready' ? { state: 'ready' } : { state: 'sealed', message: 'sealed' }
  )
  mockAuth(auth)
  const req = fakeKitRequest(path, { cookie: COOKIES.get(auth) ?? null, routeId })
  const response = await handle({ event: req.event, resolve: req.resolve } as never)
  return {
    case: `${path} ${auth} vault=${vault}`,
    setHeadersCalls: req.setHeadersCalls,
    resolvedPathnames: req.resolvedPathnames,
    ...describeResponse(response),
    localsUser: req.event.locals.user === undefined ? 'unset' : req.event.locals.user,
    chunk: req.chunk,
  }
}

describe('hooks.server handle — AC-5 whole-response oracle', () => {
  beforeEach(() => {
    resolveAuthContextMock.mockReset()
  })

  it('matches the snapshot recorded on main for every path x auth x vault case', async () => {
    const results = []
    for (const [path, routeId] of PATHS) {
      for (const auth of AUTH_CASES) {
        for (const vault of VAULT_CASES) {
          results.push(await runCase(path, routeId, auth, vault))
        }
      }
    }
    // One setHeaders call per request, redirected or not (AC-5 "ordering change made explicit").
    for (const result of results) expect(result.setHeadersCalls).toHaveLength(1)
    await expect(`${JSON.stringify(results, null, 2)}\n`).toMatchFileSnapshot(
      './__snapshots__/hooks-oracle.json'
    )
  })
})
