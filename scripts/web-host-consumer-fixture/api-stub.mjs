// A stand-in for the PV API used by run.sh (Story 68.2 AC-8, extended by Story 68.6 AC-9/AC-13).
//
//   /ready, /health, /api/health  "ready, native login enabled" (503 sealed while sealed)
//   /api/v1/auth/me               200 with a user for `cookie: session=ok`, else 401. Story 68-15: the
//                                 cookies `session=u1` and `session=u2` resolve to their own user, email
//                                 and org (`o-u1`, `o-u2`); any other cookie is 401
//   /api/v1/projects/:id          Story 68-15: 200 for a project of the caller's org (`p-u1`, `p-u2`);
//                                 the same 404 an unknown id gets for another org's project (no
//                                 existence leak); 401 without a session; 500 for `p-boom`, so PV's
//                                 own load can be made to fail
//   /api/v1/themes                Story 68-15: two themes (`base`, `dark`), none selected
//   /api/v1/themes/selection      PATCH: echoes the chosen theme name
//   /api/v1/auth/refresh          200 with `Set-Cookie: session=ok` for `cookie: refresh-token=good`
//                                 (a successful refresh, code review 68-6), else 401 (so any other
//                                 refresh cookie yields `?reason=session-expired`)
//   /__fixture/proxied            200 JSON: what a CM `after` handle proxies with `fetch()`
//   /__fixture/vault/<state>      sets the vault state (`ready` or `sealed`)
//   /__fixture/count/<name>       counts a call (the composed app's handlers call it), and records
//                                 whether the request carried the CM handleFetch header
//   /__fixture/state              the counters and every API path requested since the last reset,
//                                 as JSON, plus `calls`: each request with the session it carried
//                                 (`GET /api/v1/projects/p-u2 as u1`); /__fixture/reset clears them
//
// Everything else is a JSON 404. Plain Node, no dependencies: run.sh starts it under env -i.
import http from 'node:http'

const STUB_MESSAGE = 'fixture API stub'
const UNAUTHORIZED = { error: { code: 'unauthorized', message: STUB_MESSAGE } }
const state = { sealed: false, counts: new Map(), cmFetch: new Map(), paths: [], calls: [] }
const USER = {
  userId: 'u-fixture',
  orgId: 'o-fixture',
  orgName: 'Fixture Org',
  sessionId: 's-fixture',
  orgRole: 'member',
  isPlatformOperator: false,
  mfaEnrolled: false,
  mfaEnrolledAt: null,
  remainingRecoveryCodesCount: null,
  mfaStatus: {
    enrollmentRequired: false,
    gracePeriodActive: false,
    gracePeriodExpiresAt: null,
    gracePeriodDaysRemaining: null,
    bannerMessage: null,
  },
}

// Story 68-15: more identities, each in its own org. `session=ok` keeps the original user above.
const SESSION_USERS = new Map(
  ['u1', 'u2'].map((id) => [
    id,
    { ...USER, userId: id, email: `${id}@fixture.test`, orgId: `o-${id}`, orgName: `Org ${id}` },
  ])
)
SESSION_USERS.set('ok', USER)
// Story 69.1: a full project overview (PV's project page renders every field of a found project).
const projectOf = (id, name, orgId) => ({
  id,
  orgId,
  name,
  slug: id,
  description: null,
  role: 'owner',
  tags: [],
  memberCount: 1,
  createdBy: null,
  createdAt: '2026-07-01T12:00:00.000Z',
  updatedAt: '2026-07-01T12:00:00.000Z',
  archivedAt: null,
})
const PROJECTS = new Map([
  ['p-u1', projectOf('p-u1', 'U1 Secret', 'o-u1')],
  ['p-u2', projectOf('p-u2', 'U2 Secret', 'o-u2')],
])
const THEMES = [
  { name: 'base', label: 'Base', css: null },
  { name: 'dark', label: 'Dark', css: null },
]
const NOT_FOUND = { error: { code: 'not_found', message: STUB_MESSAGE } }

/** The session name in the cookie (`session=u1` -> `u1`), or null when the cookie names no known user. */
function sessionOf(cookie) {
  const match = /(^|;\s*)session=([^;]*)(;|$)/.exec(cookie)
  return match && SESSION_USERS.has(match[2]) ? match[2] : null
}

function readBody(req) {
  return new Promise((resolve) => {
    let input = ''
    req.on('data', (chunk) => (input += chunk))
    req.on('end', () => resolve(input))
  })
}

// Story 69.1: PV's project page reads `/projects/:id/dashboard` after the project itself; without this
// answer its own load would end in `notFound` and (by design) skip every contribution load.
const EMPTY_DASHBOARD = {
  credentialStats: { active: 0, expiringSoon: 0, expired: 0 },
  upcomingRotations: [],
  monitoredServiceHealth: { healthy: 0, degraded: 0, down: 0 },
  recentAccessEvents: [],
  unresolvedAlertCount: 0,
  isEmpty: false,
  suggestedActions: [],
}

function projectRoute(res, path, session) {
  if (session === null) return send(res, 401, UNAUTHORIZED)
  const rest = decodeURIComponent(path.slice('/api/v1/projects/'.length))
  const wantsDashboard = rest.endsWith('/dashboard')
  const id = wantsDashboard ? rest.slice(0, -'/dashboard'.length) : rest
  if (id === 'p-boom') return send(res, 500, { error: { code: 'boom', message: STUB_MESSAGE } })
  const project = PROJECTS.get(id)
  // The same answer for an unknown id and another org's project: no existence leak.
  if (project?.orgId !== SESSION_USERS.get(session).orgId) return send(res, 404, NOT_FOUND)
  return send(res, 200, { data: wantsDashboard ? EMPTY_DASHBOARD : project })
}

async function themeSelection(req, res) {
  const body = JSON.parse((await readBody(req)) || '{}')
  return send(res, 200, { data: { themeName: body.themeName ?? null } })
}

function send(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

function fixtureRoute(req, res, path) {
  const [, , action, name = ''] = path.split('/')
  if (action === 'vault') state.sealed = name === 'sealed'
  else if (action === 'proxied') return send(res, 200, { proxied: true })
  else if (action === 'reset') {
    state.counts.clear()
    state.cmFetch.clear()
    state.paths.length = 0
    state.calls.length = 0
  } else if (action === 'count') {
    state.counts.set(name, (state.counts.get(name) ?? 0) + 1)
    state.cmFetch.set(name, req.headers['x-cm-fetch'] ?? null)
  }
  send(res, 200, {
    counts: Object.fromEntries(state.counts),
    cmFetch: Object.fromEntries(state.cmFetch),
    sealed: state.sealed,
    paths: state.paths,
    calls: state.calls,
  })
}

function refreshRoute(res, cookie) {
  if (!/(^|;\s*)refresh-token=good(;|$)/.test(cookie)) return send(res, 401, UNAUTHORIZED)
  res.setHeader('set-cookie', ['session=ok; Path=/; HttpOnly', 'refresh-token=rotated; Path=/'])
  return send(res, 200, { data: { refreshed: true } })
}

function themeRoute(req, res, path, session) {
  if (session === null) return send(res, 404, NOT_FOUND)
  if (path === '/api/v1/themes') {
    return send(res, 200, { data: { themes: THEMES, selected: null, orgDefaultThemeName: null } })
  }
  return req.method === 'PATCH' ? themeSelection(req, res) : send(res, 404, NOT_FOUND)
}

function apiRoute(req, res, path, cookie, session) {
  if (['/ready', '/health', '/api/health'].includes(path)) {
    return state.sealed
      ? send(res, 503, { status: 'unavailable', reason: 'sealed', message: 'sealed' })
      : send(res, 200, { status: 'ready', nativeLoginEnabled: true })
  }
  if (path === '/api/v1/auth/me') {
    return session === null
      ? send(res, 401, UNAUTHORIZED)
      : send(res, 200, { data: SESSION_USERS.get(session) })
  }
  if (path.startsWith('/api/v1/projects/') && req.method === 'GET') {
    return projectRoute(res, path, session)
  }
  if (path === '/api/v1/themes' || path === '/api/v1/themes/selection') {
    return themeRoute(req, res, path, session)
  }
  if (path === '/api/v1/auth/refresh') return refreshRoute(res, cookie)
  return send(res, 404, NOT_FOUND)
}

http
  .createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    const cookie = req.headers.cookie ?? ''
    if (path.startsWith('/__fixture/')) return fixtureRoute(req, res, path)
    const session = sessionOf(cookie)
    state.paths.push(`${req.method} ${path}`)
    state.calls.push(`${req.method} ${path} as ${session ?? 'nobody'}`)
    return apiRoute(req, res, path, cookie, session)
  })
  .listen(Number(process.argv[2]), '127.0.0.1')
