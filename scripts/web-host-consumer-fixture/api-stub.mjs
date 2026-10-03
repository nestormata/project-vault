// A stand-in for the PV API used by run.sh (Story 68.2 AC-8, extended by Story 68.6 AC-9/AC-13).
//
//   /ready, /health, /api/health  "ready, native login enabled" (503 sealed while sealed)
//   /api/v1/auth/me               200 with a user for `cookie: session=ok`, else 401
//   /api/v1/auth/refresh          200 with `Set-Cookie: session=ok` for `cookie: refresh-token=good`
//                                 (a successful refresh, code review 68-6), else 401 (so any other
//                                 refresh cookie yields `?reason=session-expired`)
//   /__fixture/proxied            200 JSON: what a CM `after` handle proxies with `fetch()`
//   /__fixture/vault/<state>      sets the vault state (`ready` or `sealed`)
//   /__fixture/count/<name>       counts a call (the composed app's handlers call it), and records
//                                 whether the request carried the CM handleFetch header
//   /__fixture/state              the counters and every API path requested since the last reset,
//                                 as JSON; /__fixture/reset clears them
//
// Everything else is a JSON 404. Plain Node, no dependencies: run.sh starts it under env -i.
import http from 'node:http'

const UNAUTHORIZED = { error: { code: 'unauthorized', message: 'fixture API stub' } }
const state = { sealed: false, counts: new Map(), cmFetch: new Map(), paths: [] }
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
  } else if (action === 'count') {
    state.counts.set(name, (state.counts.get(name) ?? 0) + 1)
    state.cmFetch.set(name, req.headers['x-cm-fetch'] ?? null)
  }
  send(res, 200, {
    counts: Object.fromEntries(state.counts),
    cmFetch: Object.fromEntries(state.cmFetch),
    sealed: state.sealed,
    paths: state.paths,
  })
}

http
  .createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    const cookie = req.headers.cookie ?? ''
    if (path.startsWith('/__fixture/')) return fixtureRoute(req, res, path)
    state.paths.push(`${req.method} ${path}`)
    if (['/ready', '/health', '/api/health'].includes(path)) {
      return state.sealed
        ? send(res, 503, { status: 'unavailable', reason: 'sealed', message: 'sealed' })
        : send(res, 200, { status: 'ready', nativeLoginEnabled: true })
    }
    if (path === '/api/v1/auth/me') {
      return /(^|;\s*)session=ok(;|$)/.test(cookie)
        ? send(res, 200, { data: USER })
        : send(res, 401, UNAUTHORIZED)
    }
    if (path === '/api/v1/auth/refresh') {
      if (!/(^|;\s*)refresh-token=good(;|$)/.test(cookie)) return send(res, 401, UNAUTHORIZED)
      res.setHeader('set-cookie', ['session=ok; Path=/; HttpOnly', 'refresh-token=rotated; Path=/'])
      return send(res, 200, { data: { refreshed: true } })
    }
    return send(res, 404, { error: { code: 'not_found', message: 'fixture API stub' } })
  })
  .listen(Number(process.argv[2]), '127.0.0.1')
