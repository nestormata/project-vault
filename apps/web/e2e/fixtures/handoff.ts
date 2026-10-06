import { createServer } from 'node:http'
import { randomUUID, sign, type KeyObject } from 'node:crypto'
import type postgres from 'postgres'
import {
  HANDOFF_E2E_INSTANCE_ID,
  HANDOFF_E2E_ISSUER,
  HANDOFF_E2E_KID,
  HANDOFF_E2E_PROVIDER,
  HANDOFF_E2E_STUB_DEFAULT_PORT,
  handoffE2ePrivateKey,
} from './handoff-test-key.js'

/**
 * Story 60.6: fixtures for j31, the real-token cross-site handoff journey. Every DB helper takes
 * the spec's own superuser connection (`superuserDatabaseUrl()`, RLS bypassed), which the spec
 * closes in `afterAll`. Every evidence query is keyed by a seeded id, a pendingId or a minted
 * `jti`, never by "the latest row" (E5d).
 */

type Sql = postgres.Sql

export type SeededHandoffUser = {
  orgId: string
  userId: string
  email: string
  organizationName: string
  /** The CentralizeMe (WorkOS) user id, stored as `external_identities.external_subject`. */
  workosUserId: string
  /** CentralizeMe's org id, stored as `organizations.centralizeme_organization_id`. */
  centralizemeOrganizationId: string
}

/**
 * Inserts exactly what apps/api's `createLinkedHandoffOrg()` test helper inserts: an org carrying
 * a unique `centralizeme_organization_id`, a user, its identity token, an ACTIVE membership and a
 * `centralizeme-handoff` external identity. Call it inside the spec, after global-setup's DB reset.
 */
export function seedLinkedHandoffUser(sql: Sql, label: string): Promise<SeededHandoffUser> {
  const run = randomUUID()
  const organizationName = `j31-${label}-${run.slice(0, 8)}`
  const email = `j31-${label}-${run}@example.com`
  const workosUserId = `user_j31_${run}`
  const centralizemeOrganizationId = `org_j31_${run}`

  return sql.begin(async (tx) => {
    const [org] = await tx<{ id: string }[]>`
      insert into organizations (name, slug, centralizeme_organization_id)
      values (${organizationName}, ${organizationName}, ${centralizemeOrganizationId})
      returning id
    `
    const [user] = await tx<{ id: string }[]>`
      insert into users (email, password_hash) values (${email}, 'x') returning id
    `
    if (!org || !user) throw new Error(`seedLinkedHandoffUser(${label}): insert returned no row`)
    await tx`insert into user_identity_tokens (user_id, display_name) values (${user.id}, ${email})`
    await tx`
      insert into org_memberships (org_id, user_id, role, status)
      values (${org.id}, ${user.id}, 'member', 'active')
    `
    await tx`
      insert into external_identities (org_id, user_id, provider_name, external_subject)
      values (${org.id}, ${user.id}, ${HANDOFF_E2E_PROVIDER}, ${workosUserId})
    `
    return {
      orgId: org.id,
      userId: user.id,
      email,
      organizationName,
      workosUserId,
      centralizemeOrganizationId,
    }
  })
}

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

export type MintedHandoffToken = { token: string; jti: string }

/**
 * Mints the compact EdDSA JWS CentralizeMe would issue for `subject` (30 s lifetime). Mint it
 * immediately before `prepare`, never in `beforeAll`. `signingKey` lets a negative case sign with
 * a different key under the same kid.
 */
export function mintHandoffToken(
  subject: Pick<SeededHandoffUser, 'workosUserId' | 'centralizemeOrganizationId'>,
  options: { signingKey?: KeyObject; organizationId?: string } = {}
): MintedHandoffToken {
  const issuedAt = Math.floor(Date.now() / 1000)
  const jti = `jti-${randomUUID()}`
  const header = { alg: 'EdDSA', typ: 'JWT', kid: HANDOFF_E2E_KID }
  const claims = {
    iss: HANDOFF_E2E_ISSUER,
    aud: `pv:${HANDOFF_E2E_INSTANCE_ID}`,
    instanceId: HANDOFF_E2E_INSTANCE_ID,
    workosUserId: subject.workosUserId,
    providerName: HANDOFF_E2E_PROVIDER,
    organizationId: options.organizationId ?? subject.centralizemeOrganizationId,
    tier: 'pro',
    capabilities: [],
    claimsVersion: 1,
    jti,
    iat: issuedAt,
    exp: issuedAt + 30,
  }
  const signingInput = `${encodeSegment(header)}.${encodeSegment(claims)}`
  const signature = sign(
    null,
    Buffer.from(signingInput),
    options.signingKey ?? handoffE2ePrivateKey()
  )
  return { token: `${signingInput}.${signature.toString('base64url')}`, jti }
}

/** The stub port, shared with docker-compose.e2e.yml's web allowlist (E1a). */
export function handoffStubPort(): number {
  const raw = process.env['E2E_HANDOFF_STUB_PORT']
  if (!raw) return HANDOFF_E2E_STUB_DEFAULT_PORT
  const port = Number(raw)
  // j31 also listens on port + 1 (the non-allowlisted site), so the last usable port is 65534.
  if (!Number.isInteger(port) || port < 1 || port > 65534) {
    throw new Error(`E2E_HANDOFF_STUB_PORT must be an integer port in 1..65534, got "${raw}"`)
  }
  return port
}

// The fake interstitial. It reads the token from the URL FRAGMENT (never sent to this server, so
// never logged), calls PV's prepare cross-site exactly as CentralizeMe does, and then renders a
// link instead of auto-redirecting, so the test can assert the cookie drop between the two steps
// (D3). Any failure is written into #status so the test fails with a message, not a timeout.
function stubPage(pvOrigin: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Fake CentralizeMe interstitial (e2e)</title></head>
<body>
<p id="status">preparing</p>
<script type="module">
const pvOrigin = ${JSON.stringify(pvOrigin)}
const status = document.getElementById('status')
const token = new URLSearchParams(location.hash.slice(1)).get('token')
try {
  const response = await fetch(pvOrigin + '/api/v1/auth/handoff/prepare', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  const body = await response.json().catch(() => null)
  status.dataset.status = String(response.status)
  if (response.ok && body && body.data) {
    const target = new URL('/handoff', pvOrigin)
    target.searchParams.set('pendingId', body.data.pendingId)
    target.searchParams.set('claim', body.data.claim)
    if (body.data.organizationName) target.searchParams.set('organizationName', body.data.organizationName)
    if (body.data.accountLabel) target.searchParams.set('accountLabel', body.data.accountLabel)
    const link = document.createElement('a')
    link.id = 'continue'
    link.href = target.href
    link.textContent = 'Continue to Project Vault'
    document.body.append(link)
    status.textContent = 'prepared'
  } else {
    status.textContent = 'prepare rejected: HTTP ' + response.status
  }
} catch (error) {
  status.dataset.status = 'fetch-error'
  status.textContent = 'prepare fetch failed (blocked by CORS?): ' + String(error)
}
</script>
</body></html>`
}

export type CmStub = { origin: string; close: () => Promise<void> }

/**
 * Serves the fake CentralizeMe interstitial on `http://127.0.0.1:<port>`: a different SITE from
 * PV's `http://localhost:<port>` (D2). Binds 127.0.0.1 only, never 0.0.0.0 (nightly runners are
 * shared, E3b), and fails fast on a busy port.
 *
 * CentralizeMe's real navigation mechanism is unconfirmed. This models a top-level
 * navigation (a link click); if CM turns out to use an iframe or an SPA route, revisit this harness.
 */
export async function startCmStub(options: { port: number; pvOrigin: string }): Promise<CmStub> {
  const html = stubPage(options.pvOrigin)
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      response.end(html)
      return
    }
    response.writeHead(404).end()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(
              `j31 CentralizeMe stub: 127.0.0.1:${options.port} is already in use. Another run ` +
                'is probably using it; set E2E_HANDOFF_STUB_PORT to a free port in the shell for ' +
                'the whole `make e2e` run (the e2e web allowlist reads the same variable).'
            )
          : error
      )
    })
    server.listen(options.port, '127.0.0.1', () => resolve())
  })

  return {
    origin: `http://127.0.0.1:${options.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

// --- DB evidence (superuser; every query keyed by a seeded id, a pendingId or a jti) ----------

export async function dbNow(sql: Sql): Promise<Date> {
  const [row] = await sql<{ now: Date }[]>`select clock_timestamp() as now`
  if (!row) throw new Error('dbNow: no row')
  return row.now
}

export async function countSessions(sql: Sql, userId: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from sessions where user_id = ${userId}
  `
  return row?.count ?? 0
}

export async function isJtiBurned(sql: Sql, jti: string): Promise<boolean> {
  const [row] = await sql<{ burned: boolean }[]>`
    select exists (select 1 from handoff_token_jti where jti = ${jti}) as burned
  `
  return row?.burned ?? false
}

/**
 * The claim's burn row is `claim:<HMAC(claim)>`, and the HMAC key is the stack's per-run throwaway
 * secret, which the test never sees. So the burn key is resolved through the pending row's own
 * stored `claim_hash` (the same HMAC), keyed by pendingId.
 */
export async function isClaimBurned(sql: Sql, pendingId: string): Promise<boolean> {
  const [row] = await sql<{ burned: boolean }[]>`
    select exists (
      select 1
      from handoff_pending_states pending
      join handoff_token_jti burned on burned.jti = 'claim:' || pending.claim_hash
      where pending.id = ${pendingId}
    ) as burned
  `
  return row?.burned ?? false
}

export async function countPendingStatesForJti(sql: Sql, jti: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from handoff_pending_states where jti = ${jti}
  `
  return row?.count ?? 0
}

export async function countLoginSucceededAudit(sql: Sql, user: SeededHandoffUser): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count
    from audit_log_entries entry
    join user_identity_tokens token on token.id = entry.actor_token_id
    where entry.org_id = ${user.orgId}
      and token.user_id = ${user.userId}
      and entry.event_type = 'handoff_login_succeeded'
  `
  return row?.count ?? 0
}

export type SecurityEventRow = { eventType: string; payload: unknown }

/**
 * Pre-org handoff rejections carry no user or org id (`platform_security_events`), so they are
 * scoped by time: rows written since `since` (a `dbNow()` taken right before the attempt). Safe
 * because the suite runs with `workers: 1`.
 */
export function securityEventsSince(sql: Sql, since: Date): Promise<SecurityEventRow[]> {
  return sql<SecurityEventRow[]>`
    select event_type as "eventType", payload
    from platform_security_events
    where created_at >= ${since} and event_type like 'handoff_%'
    order by created_at
  `
}
