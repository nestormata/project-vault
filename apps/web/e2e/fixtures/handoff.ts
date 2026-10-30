import { createServer, type ServerResponse } from 'node:http'
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
 * Story 60.6 / 73.1: fixtures for j31, the real-token cross-site handoff journey. Every DB helper
 * takes the spec's own superuser connection (`superuserDatabaseUrl()`, RLS bypassed), which the
 * spec closes in `afterAll`. Every evidence query is keyed by a seeded id or a minted `jti`, never
 * by "the latest row" (E5d). Nonce rows are stored as an HMAC under the stack's per-run secret, so
 * they are scoped by creation time instead (`workers: 1`).
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
 * `mfaEnrolled` sets `users.mfa_enrolled_at`, which sends the claim to the MFA challenge.
 */
export function seedLinkedHandoffUser(
  sql: Sql,
  label: string,
  options: { mfaEnrolled?: boolean } = {}
): Promise<SeededHandoffUser> {
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
      insert into users (email, password_hash, mfa_enrolled_at)
      values (${email}, 'x', ${options.mfaEnrolled ? new Date() : null})
      returning id
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

export type MintOptions = {
  signingKey?: KeyObject
  organizationId?: string
  instanceId?: string
  /** Story 73.1: the browser-bound nonce claim; omitted when undefined. */
  nonce?: string
}

/**
 * Mints the compact EdDSA JWS CentralizeMe would issue for `subject` (30 s lifetime). Mint it
 * immediately before the claim, never in `beforeAll`. `signingKey` lets a negative case sign with
 * a different key under the same kid.
 */
export function mintHandoffToken(
  subject: Pick<SeededHandoffUser, 'workosUserId' | 'centralizemeOrganizationId'>,
  options: MintOptions = {}
): MintedHandoffToken {
  const issuedAt = Math.floor(Date.now() / 1000)
  const jti = `jti-${randomUUID()}`
  const instanceId = options.instanceId ?? HANDOFF_E2E_INSTANCE_ID
  const header = { alg: 'EdDSA', typ: 'JWT', kid: HANDOFF_E2E_KID }
  const claims = {
    iss: HANDOFF_E2E_ISSUER,
    aud: `pv:${instanceId}`,
    instanceId,
    workosUserId: subject.workosUserId,
    providerName: HANDOFF_E2E_PROVIDER,
    organizationId: options.organizationId ?? subject.centralizemeOrganizationId,
    tier: 'pro',
    capabilities: [],
    claimsVersion: 1,
    jti,
    iat: issuedAt,
    exp: issuedAt + 30,
    ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
  }
  const signingInput = `${encodeSegment(header)}.${encodeSegment(claims)}`
  const signature = sign(
    null,
    Buffer.from(signingInput),
    options.signingKey ?? handoffE2ePrivateKey()
  )
  return { token: `${signingInput}.${signature.toString('base64url')}`, jti }
}

/** The stub port, shared with docker-compose.e2e.yml's `VAULT_HANDOFF_START_URL` (E1a). */
export function handoffStubPort(): number {
  const raw = process.env['E2E_HANDOFF_STUB_PORT']
  if (!raw) return HANDOFF_E2E_STUB_DEFAULT_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`E2E_HANDOFF_STUB_PORT must be an integer port in 1..65535, got "${raw}"`)
  }
  return port
}

/**
 * What the fake issuer does on `GET /start?nonce=`: `redirect` signs a token bound to the nonce
 * and answers 302 to PV's `/auth/claim#<token>` (the real flow); `return` answers 200 with the
 * token as text, so an attacker context can capture its own token; `hold` answers 200 and signs
 * nothing, so a victim context keeps a fresh nonce cookie and no token.
 */
export type IssuerMode = 'redirect' | 'return' | 'hold'

export type IssuerPlan = {
  subject: Pick<SeededHandoffUser, 'workosUserId' | 'centralizemeOrganizationId'>
  mode: IssuerMode
  organizationId?: string
}

/** One `/start` hit: the nonce the browser brought, and the token signed for it (null on hold). */
export type IssuerHit = { nonce: string; minted: MintedHandoffToken | null }

export type FakeIssuer = {
  origin: string
  plan: (next: IssuerPlan) => void
  /** Every `/start` hit, oldest first. */
  hits: IssuerHit[]
  close: () => Promise<void>
}

// A page on the issuer's origin that POSTs a token from its fragment to PV's claim route
// cross-site, with credentials, and reports the outcome in #status (case: cross-site POST).
function crossSitePage(pvOrigin: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Cross-site claim attempt (e2e)</title></head>
<body>
<p id="status">posting</p>
<script type="module">
const status = document.getElementById('status')
try {
  const response = await fetch(${JSON.stringify(pvOrigin)} + '/api/v1/auth/handoff/claim', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: location.hash.slice(1) }),
  })
  status.dataset.status = String(response.status)
} catch (error) {
  status.dataset.status = 'fetch-error'
  status.textContent = String(error)
}
</script>
</body></html>`
}

// A page on the issuer's origin that sends a top-level, no-preflight form POST (text/plain) to
// PV's claim route: the realistic cross-site attack, which CORS does not stop before PV.
function crossSiteFormPage(pvOrigin: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Cross-site form claim attempt (e2e)</title></head>
<body>
<form id="attack" method="post" enctype="text/plain"
  action="${pvOrigin}/api/v1/auth/handoff/claim"><input name="token" value=""></form>
<script>
document.querySelector('input[name=token]').value = location.hash.slice(1)
document.getElementById('attack').submit()
</script>
</body></html>`
}

function respond(
  response: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body = ''
): void {
  response.writeHead(status, { 'cache-control': 'no-store', ...headers })
  response.end(body)
}

/**
 * Serves the fake issuer on `http://127.0.0.1:<port>`: a different SITE from PV's
 * `http://localhost:<port>` (D2). Binds 127.0.0.1 only, never 0.0.0.0 (nightly runners are
 * shared, E3b), and fails fast on a busy port. The e2e api's `VAULT_HANDOFF_START_URL` points at
 * its `/start`.
 */
export async function startFakeIssuer(options: {
  port: number
  pvOrigin: string
}): Promise<FakeIssuer> {
  let current: IssuerPlan | null = null
  const hits: IssuerHit[] = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const route = request.method === 'GET' ? url.pathname : ''
    if (route === '/cross-site') {
      const page = crossSitePage(options.pvOrigin)
      respond(response, 200, { 'content-type': 'text/html; charset=utf-8' }, page)
    } else if (route === '/cross-site-form') {
      const page = crossSiteFormPage(options.pvOrigin)
      respond(response, 200, { 'content-type': 'text/html; charset=utf-8' }, page)
    } else if (route === '/start' && current) {
      issue(current, url.searchParams.get('nonce') ?? '', response)
    } else {
      respond(response, 404, {})
    }
  })

  function issue(plan: IssuerPlan, nonce: string, response: ServerResponse): void {
    if (plan.mode === 'hold') {
      hits.push({ nonce, minted: null })
      respond(response, 200, { 'content-type': 'text/plain' }, 'held')
      return
    }
    const organization =
      plan.organizationId === undefined ? {} : { organizationId: plan.organizationId }
    const minted = mintHandoffToken(plan.subject, { nonce, ...organization })
    hits.push({ nonce, minted })
    if (plan.mode === 'return') {
      respond(response, 200, { 'content-type': 'text/plain' }, minted.token)
    } else {
      respond(response, 302, { location: `${options.pvOrigin}/auth/claim#${minted.token}` })
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(
              `j31 fake issuer: 127.0.0.1:${options.port} is already in use. Another run is ` +
                'probably using it; set E2E_HANDOFF_STUB_PORT to a free port in the shell for the ' +
                'whole `make e2e` run (the e2e api start URL reads the same variable).'
            )
          : error
      )
    })
    server.listen(options.port, '127.0.0.1', () => resolve())
  })

  return {
    origin: `http://127.0.0.1:${options.port}`,
    plan: (next) => {
      current = next
    },
    hits,
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

export type NonceRow = { consumedAt: Date | null; expiresAt: Date }

/** Nonce rows written since `since` (a `dbNow()` taken right before `/auth/start`). */
export function nonceRowsSince(sql: Sql, since: Date): Promise<NonceRow[]> {
  return sql<NonceRow[]>`
    select consumed_at as "consumedAt", expires_at as "expiresAt"
    from handoff_nonces
    where created_at >= ${since}
    order by created_at
  `
}

/** Moves the expiry of every nonce row written since `since` into the past. */
export async function expireNonceRowsSince(sql: Sql, since: Date): Promise<number> {
  const rows = await sql`
    update handoff_nonces set expires_at = now() - interval '1 second'
    where created_at >= ${since}
    returning nonce_hash
  `
  return rows.length
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
