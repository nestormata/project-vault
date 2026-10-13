import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import type postgres from 'postgres'
import {
  DELEGATION_E2E_PROVIDER,
  signDelegationE2eAssertion,
  type DelegationE2eAssertionInput,
} from './delegation-test-key.js'

/**
 * Story 71.5: fixtures for j36, the real-host proof of Epic 71. Every DB helper takes the spec's
 * own superuser connection to the journey's isolated database (RLS bypassed), and every query is
 * keyed by a seeded id, a minted `jti` or a unique event type, never by "the latest row".
 */

type Sql = postgres.Sql

/** The event-type namespace the host derives from the fixture extension's manifest name. */
export const FIXTURE_EVENT_PREFIX = 'ext.test.mock-delegation-audit-extension.'
export const WRITE_URL = '/api/v1/ext/mock-delegation/audit-events'
export const GATE_URL = '/api/v1/ext/mock-delegation/gate'
export const WRITE_KEY = `POST ${WRITE_URL}`
export const GATE_KEY = `POST ${GATE_URL}`
/** The fixture route's historical window (`HISTORICAL_MAX_AGE_SECONDS` in the fixture package). */
export const HISTORICAL_WINDOW_SECONDS = 3600

export type SeededOrg = { orgId: string; cmOrgId: string }

/** Links an existing org (an owner registered over HTTP) to a fresh CentralizeMe organization id. */
export async function linkOrgToCentralizeMe(sql: Sql, orgId: string): Promise<SeededOrg> {
  const cmOrgId = `org_j36_${randomUUID()}`
  await sql`update organizations set centralizeme_organization_id = ${cmOrgId} where id = ${orgId}`
  return { orgId, cmOrgId }
}

/** An org with a CentralizeMe id and no human owner (the second tenant of the isolation case). */
export async function seedLinkedOrg(sql: Sql, label: string): Promise<SeededOrg> {
  const name = `j36-${label}-${randomUUID().slice(0, 8)}`
  const cmOrgId = `org_j36_${randomUUID()}`
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, centralizeme_organization_id)
    values (${name}, ${name}, ${cmOrgId}) returning id
  `
  if (!org) throw new Error(`seedLinkedOrg(${label}): insert returned no row`)
  return { orgId: org.id, cmOrgId }
}

export type SeededActor = { sub: string; userId: string }

/**
 * A linked actor: a PV user, an identity token, an external identity for the delegation provider
 * and (unless `none`) a membership with the given status. An UNLINKED actor needs no seeding: it
 * is any subject with no `external_identities` row.
 */
export function seedActor(
  sql: Sql,
  orgId: string,
  membership: 'active' | 'deactivated' | 'none'
): Promise<SeededActor> {
  const run = randomUUID()
  const sub = `user_j36_${run}`
  const email = `j36-actor-${run}@example.com`
  return sql.begin(async (tx) => {
    const [user] = await tx<{ id: string }[]>`
      insert into users (email, password_hash) values (${email}, 'x') returning id
    `
    if (!user) throw new Error('seedActor: user insert returned no row')
    await tx`insert into user_identity_tokens (user_id, display_name) values (${user.id}, ${email})`
    if (membership !== 'none') {
      await tx`
        insert into org_memberships (org_id, user_id, role, status)
        values (${orgId}, ${user.id}, 'member', ${membership})
      `
    }
    await tx`
      insert into external_identities (org_id, user_id, provider_name, external_subject)
      values (${orgId}, ${user.id}, ${DELEGATION_E2E_PROVIDER}, ${sub})
    `
    return { sub, userId: user.id }
  })
}

export function newEventType(label: string): string {
  return `${FIXTURE_EVENT_PREFIX}${label}_${randomUUID().slice(0, 8)}`
}

export type AuditRow = {
  id: string
  org_id: string
  actor_type: string
  event_type: string
  resource_type: string | null
  resource_id: string | null
  payload: Record<string, unknown>
  created_at: Date
}

export function auditRows(sql: Sql, orgId: string, eventType: string): Promise<AuditRow[]> {
  return sql<AuditRow[]>`
    select id, org_id, actor_type, event_type, resource_type, resource_id, payload, created_at
    from audit_log_entries where org_id = ${orgId} and event_type = ${eventType}
  `
}

export async function auditRowCount(sql: Sql, orgId: string, eventType: string): Promise<number> {
  return (await auditRows(sql, orgId, eventType)).length
}

export async function burnedJtiCount(sql: Sql, orgId: string, jti: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from delegation_assertion_jti
    where org_id = ${orgId} and jti = ${jti}
  `
  return row?.count ?? 0
}

/**
 * Rejection rows in `platform_security_events` for one reason. The row carries a `jtiHash` only
 * when the pipeline knew the jti (not for a verifier-level rejection such as `expired`), so cases
 * compare this count before and after their one request.
 */
export async function securityEventCount(sql: Sql, reason: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from platform_security_events
    where event_type = 'delegation_assertion_rejected' and payload->>'reason' = ${reason}
  `
  return row?.count ?? 0
}

export async function countTable(
  sql: Sql,
  table: 'handoff_pending_states' | 'handoff_token_jti' | 'sessions' | 'platform_security_events'
): Promise<number> {
  const [row] = await sql<{ count: number }[]>`select count(*)::int as count from ${sql(table)}`
  return row?.count ?? 0
}

// --- the wire -------------------------------------------------------------------------------

export type DelegatedResponse = {
  status: number
  body: Record<string, unknown>
  headers: Headers
  jti: string
  token: string
  raw: string
}

export type DelegatedCall = {
  apiBase: string
  org: string
  sub: string
  /** The JSON body; the assertion's `bsh` commits to its exact serialization. */
  payload: Record<string, unknown>
  url?: string
  op?: string
  assertion?: Partial<DelegationE2eAssertionInput>
  /** Send this token instead of a freshly signed one. */
  token?: string
}

export async function postDelegated(call: DelegatedCall): Promise<DelegatedResponse> {
  const raw = JSON.stringify(call.payload)
  const jti = `jti-${randomUUID()}`
  const claims = { jti, ...call.assertion?.claims }
  const token =
    call.token ??
    signDelegationE2eAssertion({
      apiBase: call.apiBase,
      org: call.org,
      sub: call.sub,
      op: call.op ?? WRITE_KEY,
      body: raw,
      ...call.assertion,
      claims,
    })
  const response = await sendOnce(`${call.apiBase}${call.url ?? WRITE_URL}`, token, raw)
  return {
    status: response.status,
    body: parseJsonObject(response.text),
    headers: response.headers,
    jti: String(claims['jti']),
    token,
    raw: response.text,
  }
}

/**
 * One HTTP request, exactly once. `fetch` (undici) transparently re-sends a request that was
 * answered `421 Misdirected Request`, which is what a wrong-audience assertion earns, so a
 * counter assertion through `fetch` would see two requests for one.
 */
function sendOnce(
  url: string,
  token: string,
  body: string
): Promise<{ status: number; headers: Headers; text: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
          authorization: `PV-Delegation ${token}`,
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const headers = new Headers()
          for (const [name, value] of Object.entries(response.headers)) {
            if (value !== undefined)
              headers.set(name, Array.isArray(value) ? value.join(', ') : value)
          }
          resolve({
            status: response.statusCode ?? 0,
            headers,
            text: Buffer.concat(chunks).toString('utf8'),
          })
        })
      }
    )
    request.on('error', reject)
    request.end(body)
  })
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

// --- counters -------------------------------------------------------------------------------

/** `pv_delegation_assertions_total` summed across `kid`, one number per outcome. */
export async function delegationOutcomeTotals(apiBase: string): Promise<Record<string, number>> {
  // `/metrics` is served on the api port and answers loopback callers only.
  const text = await (await fetch(`${apiBase}/metrics`)).text()
  const totals = new Map<string, number>()
  for (const line of text.split('\n')) {
    const match = /^pv_delegation_assertions_total\{([^}]*)\}\s+(\S+)$/.exec(line)
    const outcome = match?.[1]?.match(/outcome="([^"]*)"/)?.[1]
    if (match && outcome) totals.set(outcome, (totals.get(outcome) ?? 0) + Number(match[2]))
  }
  return Object.fromEntries(totals)
}

/** How much each outcome total grew between two snapshots (only the outcomes that moved). */
export function outcomeDeltas(
  before: Record<string, number>,
  after: Record<string, number>
): Record<string, number> {
  const names = new Set([...Object.keys(before), ...Object.keys(after)])
  const deltas = new Map<string, number>()
  for (const name of names) {
    const grew = (Reflect.get(after, name) ?? 0) - (Reflect.get(before, name) ?? 0)
    if (grew !== 0) deltas.set(name, grew)
  }
  return Object.fromEntries(deltas)
}

/** The host's audit-event-source hook counters from the loopback-only `GET /status`. */
export async function auditSourceCounters(
  apiBase: string
): Promise<{ writes: number; succeeded: number; rejected: number; deduped: number }> {
  const response = await fetch(`${apiBase}/status`)
  const body = (await response.json()) as {
    auditEventSource?: {
      counters: { writes: number; succeeded: number; rejected: number; deduped: number }
    }
  }
  if (!body.auditEventSource)
    throw new Error(`/status has no auditEventSource (${response.status})`)
  return body.auditEventSource.counters
}
