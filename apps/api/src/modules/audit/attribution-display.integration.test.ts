import { randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { getDb, withOrg, type Tx } from '@project-vault/db'
import { auditExports, auditLogEntries, organizations } from '@project-vault/db/schema'
import type { ExtensionManifest } from '@project-vault/extension-api'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  initVaultForTest,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createLogCaptureStream } from '../../__tests__/helpers/capture-logs.js'
import {
  createDelegationOrg,
  DELEGATION_TEST_INSTANCE_ID,
  delegationTestVerifyKeysJson,
  linkDelegationActor,
  signDelegationAssertion,
  type AssertionOptions,
} from '../../__tests__/helpers/delegation-test-helpers.js'

/**
 * Story 71.10 AC-1..AC-6 — the audit reader/export display of issuer-attested actors, over REAL
 * delegated writes (real `secureRoute`, real `writeExtensionAuditEventForManifest`, real Postgres),
 * read back through the real `GET /audit/events` and the real export worker. No mock.
 */

process.env['VAULT_DELEGATION_VERIFY_KEYS'] = delegationTestVerifyKeysJson()
process.env['VAULT_HANDOFF_INSTANCE_ID'] = DELEGATION_TEST_INSTANCE_ID

const { createApp, initVault } = await bootstrapRouteIntegrationTest()
const { loadedApiRoutesState } = await import('../../__tests__/helpers/secure-route-stubs.js')
const { default: authenticatePlugin } = await import('../../plugins/authenticate.js')
const { installApiRoutes, registerApiRouteAdds } =
  await import('../../extensions/api-routes/install.js')
const { writeExtensionAuditEventForManifest } = await import('../../lib/audit-event-source.js')
const { writeExtensionAuditEntry } = await import('./extension-entry.js')
const { runAuditExport } = await import('./export.js')
const { verifyAuditRange } = await import('./verify.js')
const { resetVaultForTest } = await import('../../__tests__/helpers/vault-test-cleanup.js')

const URL_PATH = '/cm/attribution-display-events'
const KEY = `POST ${URL_PATH}`
const DAY = 86_400
const MANIFEST_NAME = 'com.acme.attribdisplay'
const MANIFEST: ExtensionManifest = {
  name: MANIFEST_NAME,
  apiVersion: '3.33.0',
  capabilities: ['audit-event-source'],
}
const POLICY = { historicalActorPolicy: { maxAgeSeconds: 30 * DAY } }
const PROVIDER = 'centralizeme-handoff'
const U202E = String.fromCodePoint(0x202e)
const EVENTS_URL = '/api/v1/org/audit/events'
const EXPORT_URL = '/api/v1/org/audit/export'

type TestApp = Awaited<ReturnType<typeof createApp>>
type SearchRow = {
  id: string
  eventType: string
  actorDisplayName: string
  attribution?: {
    actor?: { kind: string; provider: string; subject: string; reason: string | null }
    occurredAt?: string
    occurredAtSource?: string
  }
}
type SearchBody = { data: SearchRow[]; total: number }

const readerLogs = createLogCaptureStream()
const delegatedApps: FastifyInstance[] = []
let reader: TestApp
let ownerCookies: Record<string, string>
let orgId: string
let cmOrgId: string
let delegatedApp: FastifyInstance
let caseNumber = 0

const unlinkedSub = `user_unlinked_${randomUUID()}`
const memberSub = `user_member_${randomUUID()}`
const formerSub = `user_former_${randomUUID()}`
let memberUserId: string
let formerUserId: string
const written: Record<'unlinked' | 'member' | 'former', string> = {
  unlinked: '',
  member: '',
  former: '',
}

function nextEventType(): string {
  caseNumber += 1
  return `ext.${MANIFEST_NAME}.case_${caseNumber}`
}

async function bootDelegatedApp(): Promise<FastifyInstance> {
  const handler = async (ctx: Record<string, unknown>, req: FastifyRequest) => {
    const body = req.body as { orgId: string }
    const receipt = await writeExtensionAuditEventForManifest(
      MANIFEST,
      { orgId: body.orgId, eventType: nextEventType(), payload: {} } as never,
      { logger: req.log as never }
    )
    void ctx
    return { receipt }
  }
  const app = Fastify({ logger: false, routerOptions: { ignoreTrailingSlash: true } })
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  await app.register(authenticatePlugin)
  const runtime = installApiRoutes(
    app as never,
    loadedApiRoutesState(
      {
        add: [
          {
            method: 'POST',
            url: URL_PATH,
            options: { security: { delegation: POLICY, writeAuditEvent: false } },
          },
        ],
      },
      { [KEY]: { handler } }
    )
  )
  await app.after()
  await registerApiRouteAdds(app as never, runtime, {
    logger: { info: vi.fn(), warn: vi.fn() } as never,
    docsEnabled: true,
  })
  await app.ready()
  delegatedApps.push(app)
  return app
}

async function delegatedWrite(
  sub: string,
  options: { toOrg?: { orgId: string; cmOrgId: string }; assertion?: AssertionOptions } = {}
): Promise<string> {
  const target = options.toOrg ?? { orgId, cmOrgId }
  const raw = JSON.stringify({ orgId: target.orgId })
  const token = signDelegationAssertion(
    { org: target.cmOrgId, sub, op: KEY, body: raw },
    options.assertion
  )
  const res = await delegatedApp.inject({
    method: 'POST',
    url: URL_PATH,
    payload: raw,
    headers: { 'content-type': 'application/json', authorization: `PV-Delegation ${token}` },
  })
  expect(res.statusCode).toBe(200)
  return (JSON.parse(res.body) as { receipt: { id: string } }).receipt.id
}

function occ(ageSeconds: number): AssertionOptions {
  return { claims: { occ: Math.floor(Date.now() / 1000) - ageSeconds } }
}

async function search(query: string, cookies = ownerCookies) {
  return reader.inject({
    method: 'GET',
    url: `${EVENTS_URL}${query === '' ? '' : `?${query}`}`,
    headers: { cookie: cookieHeader(cookies) },
  })
}

async function searchOk(query: string): Promise<SearchBody> {
  const res = await search(query)
  expect(res.statusCode).toBe(200)
  return res.json<SearchBody>()
}

async function searchRunCount(): Promise<number> {
  const rows = await withOrg(orgId, (tx) =>
    (tx as Tx)
      .select({ id: auditLogEntries.id })
      .from(auditLogEntries)
      .where(sql`${auditLogEntries.eventType} = 'audit.search_run'`)
  )
  return rows.length
}

function storedActor(subject: string, overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    actor: {
      provider: 'p',
      subject,
      userId: null,
      attestation: 'issuer_attested',
      reason: 'unlinked',
      ...overrides,
    },
  }
}

/** Shapes the strict reader must refuse, each carrying `secret` so a leak is detectable. */
function malformedAttributions(secret: string): unknown[] {
  return [
    'not-an-object',
    [1, 2],
    { v: 2, actor: { provider: 'p', subject: secret } },
    storedActor(secret, { attestation: 'pv_verified' }),
    storedActor(`${secret}${U202E}spoof`),
    storedActor(secret.padEnd(300, 'x')),
  ]
}

function q(params: Record<string, string>): string {
  return new URLSearchParams(params).toString()
}

beforeAll(async () => {
  await resetVaultForTest()
  await initVaultForTest(initVault, 'attribution-display-integration-passphrase')
  reader = await createApp({
    logger: { level: 'debug', stream: readerLogs.stream },
    vaultGuardEnabled: true,
  })
  const owner = await registerAndLoginViaApi(reader, {
    email: `attrib-display-${randomUUID()}@example.com`,
    password: randomUUID().replaceAll('-', 'x') + 'Aa1!',
    orgName: `attrib-display ${randomUUID()}`,
  })
  orgId = owner.orgId
  ownerCookies = owner.cookies
  cmOrgId = `cm-org-${randomUUID()}`
  await getDb()
    .update(organizations)
    .set({ centralizemeOrganizationId: cmOrgId })
    .where(eq(organizations.id, orgId))

  memberUserId = (await linkDelegationActor(orgId, memberSub)).userId
  formerUserId = (await linkDelegationActor(orgId, formerSub, { membership: 'deactivated' })).userId
  delegatedApp = await bootDelegatedApp()
  written.unlinked = await delegatedWrite(unlinkedSub, { assertion: occ(30) })
  written.member = await delegatedWrite(memberSub, { assertion: occ(3600) })
  written.former = await delegatedWrite(formerSub, { assertion: occ(2 * DAY) })
}, 120_000)

afterAll(async () => {
  await Promise.all(delegatedApps.map((app) => app.close()))
  await reader.close()
  await resetVaultForTest()
})

describe('AC-1 search DTO', () => {
  it('shows the three attestation classes, keeps actorDisplayName "extension", exposes no operator data', async () => {
    const res = await search('limit=100')
    expect(res.statusCode).toBe(200)
    const body = res.json<SearchBody>()
    const byId = new Map(body.data.map((row) => [row.id, row]))

    const actorOf = (id: string) => byId.get(id)?.attribution?.actor
    const unlinked = byId.get(written.unlinked)
    expect(unlinked?.actorDisplayName).toBe('extension')
    expect(actorOf(written.unlinked)).toEqual({
      kind: 'issuer_attested',
      provider: PROVIDER,
      subject: unlinkedSub,
      reason: 'unlinked',
    })
    expect(unlinked?.attribution?.occurredAtSource).toBe('delegation_signed')
    expect(unlinked?.attribution?.occurredAt).toEqual(expect.any(String))

    expect(actorOf(written.former)).toEqual({
      kind: 'issuer_attested',
      provider: PROVIDER,
      subject: formerSub,
      reason: 'not_current_member',
    })
    expect(actorOf(written.member)).toEqual({
      kind: 'pv_verified',
      provider: PROVIDER,
      subject: memberSub,
      reason: null,
    })

    const text = res.body
    expect(text).not.toContain(memberUserId)
    expect(text).not.toContain(formerUserId)
    expect(text).not.toMatch(/delegatedBy|assertionId|"kid"|userId|cm-deleg-test/)
  })

  it('returns no attribution key for rows without a stored attribution', async () => {
    const body = await searchOk('limit=100')
    const attributed = new Set(Object.values(written))
    const plain = body.data.filter((row) => !attributed.has(row.id))
    expect(plain.length).toBeGreaterThan(0)
    for (const row of plain) expect(Object.keys(row)).not.toContain('attribution')
  })

  it('renders a malformed stored attribution as a legacy row: 200, no key, no value in any log line', async () => {
    const secretSubject = `malformed-subject-${randomUUID()}`
    const rows = malformedAttributions(secretSubject)
    const receipts = await Promise.all(
      rows.map((attribution) =>
        withOrg(orgId, (tx) =>
          writeExtensionAuditEntry(tx as Tx, {
            orgId,
            eventType: nextEventType(),
            payload: {},
            extensionName: MANIFEST_NAME,
            attribution: attribution as never,
          })
        )
      )
    )
    const ids = receipts.map((receipt) => receipt.id)
    const res = await search('limit=100')
    expect(res.statusCode).toBe(200)
    const body = res.json<SearchBody>()
    for (const id of ids) {
      const row = body.data.find((candidate) => candidate.id === id)
      expect(row).toBeDefined()
      expect(Object.keys(row ?? {})).not.toContain('attribution')
    }
    expect(res.body).not.toContain(secretSubject)
    expect(readerLogs.lines.join('')).not.toContain(secretSubject)
  })
})

describe('AC-2 provider + subject filter', () => {
  it('returns exactly the rows attributed to that subject, with a correct total', async () => {
    const second = await delegatedWrite(unlinkedSub, { assertion: occ(10) })
    const body = await searchOk(q({ actorProvider: PROVIDER, actorSubject: unlinkedSub }))
    expect(body.total).toBe(2)
    expect(body.data.map((row) => row.id)).toEqual([second, written.unlinked])
    const member = await searchOk(q({ actorProvider: PROVIDER, actorSubject: memberSub }))
    expect(member.data.map((row) => row.id)).toEqual([written.member])
    const former = await searchOk(q({ actorProvider: PROVIDER, actorSubject: formerSub }))
    expect(former.data.map((row) => row.id)).toEqual([written.former])
  })

  it('keeps actorId as the PV-user filter: it never returns delegated rows, even for a stored userId', async () => {
    const byFormer = await searchOk(q({ actorId: formerUserId }))
    expect(byFormer.data.map((row) => row.id)).not.toContain(written.former)
    const byMember = await searchOk(q({ actorId: memberUserId }))
    expect(byMember.data.map((row) => row.id)).not.toContain(written.member)
  })

  it.each([
    ['provider alone', { actorProvider: PROVIDER }],
    ['subject alone', { actorSubject: 'x' }],
    ['empty provider', { actorProvider: '', actorSubject: 'x' }],
    ['empty subject', { actorProvider: PROVIDER, actorSubject: '' }],
    ['subject over 256', { actorProvider: PROVIDER, actorSubject: 'a'.repeat(257) }],
    [
      'subject with NUL (jsonb cannot hold it)',
      { actorProvider: PROVIDER, actorSubject: 'a\u0000b' },
    ],
    [
      'actorId with provider and subject',
      { actorId: randomUUID(), actorProvider: PROVIDER, actorSubject: 'x' },
    ],
  ])('rejects %s with 422 invalid_actor_filter and writes no search audit row', async (_n, p) => {
    const before = await searchRunCount()
    const res = await search(q(p))
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ code: 'invalid_actor_filter' })
    expect(await searchRunCount()).toBe(before)
  })

  it.each([
    ['different case', unlinkedSub.toUpperCase()],
    ['a prefix', unlinkedSub.slice(0, 10)],
    ['percent', '%'],
    ['underscore', '_'],
    ['quote', '"'],
    ['backslash', '\\'],
    ['brace', '{'],
  ])('matches nothing and breaks nothing for %s', async (_n, subject) => {
    const body = await searchOk(q({ actorProvider: PROVIDER, actorSubject: subject }))
    expect(body).toMatchObject({ total: 0, data: [] })
  })

  it('does not match a different provider with the same subject', async () => {
    const body = await searchOk(q({ actorProvider: 'other-provider', actorSubject: memberSub }))
    expect(body.total).toBe(0)
  })

  it('is tenant-scoped: the same subject attributed in another org is invisible and uncounted', async () => {
    const orgB = await createDelegationOrg('attrib-display-b')
    await delegatedWrite(unlinkedSub, { toOrg: orgB, assertion: occ(5) })
    const body = await searchOk(q({ actorProvider: PROVIDER, actorSubject: unlinkedSub }))
    expect(body.total).toBe(2)
  })

  it('records the filter fields and result count in the audit.search_run payload', async () => {
    await searchOk(q({ actorProvider: PROVIDER, actorSubject: memberSub }))
    const rows = await withOrg(orgId, (tx) =>
      (tx as Tx)
        .select({ payload: auditLogEntries.payload })
        .from(auditLogEntries)
        .where(sql`${auditLogEntries.eventType} = 'audit.search_run'`)
        .orderBy(sql`${auditLogEntries.createdAt} desc`)
        .limit(1)
    )
    expect(rows[0]?.payload).toMatchObject({
      actorProvider: PROVIDER,
      actorSubject: memberSub,
      resultCount: 1,
    })
  })

  it('selects by createdAt, never by occurredAt (display-only)', async () => {
    const id = await delegatedWrite(`user_old_${randomUUID()}`, { assertion: occ(20 * DAY) })
    const from = new Date(Date.now() - 20 * DAY * 1000 - 3_600_000).toISOString()
    const to = new Date(Date.now() - 15 * DAY * 1000).toISOString()
    const old = await searchOk(q({ from, to }))
    expect(old.data.map((row) => row.id)).not.toContain(id)
    const recent = await searchOk(q({ from: new Date(Date.now() - 600_000).toISOString() }))
    expect(recent.data.map((row) => row.id)).toContain(id)
  })
})

describe('AC-3 / AC-5 export and chain integrity', () => {
  it('exports the five trailing columns for each class and the chain still verifies', async () => {
    const from = new Date(Date.now() - 3_600_000).toISOString()
    const to = new Date(Date.now() + 3_600_000).toISOString()
    const trigger = await reader.inject({
      method: 'POST',
      url: EXPORT_URL,
      headers: { cookie: cookieHeader(ownerCookies) },
      payload: { from, to, format: 'csv', includeIntegrityReport: true },
    })
    expect(trigger.statusCode).toBe(202)
    const exportId = trigger.json<{ data: { jobId: string } }>().data.jobId
    await runAuditExport({ exportId, orgId })
    const [job] = await withOrg(orgId, (tx) =>
      (tx as Tx).select().from(auditExports).where(eq(auditExports.id, exportId))
    )
    expect(job?.status).toBe('completed')
    const csv = gunzipSync(job?.fileContent as Buffer).toString('utf8')
    const lines = csv.split('\n')
    expect(lines[0]).toBe(
      'timestamp,actor_display_name,event_type,resource_id,resource_type,org_id,project_id,ip_address,' +
        'actor_attestation,actor_attestation_reason,actor_provider,actor_subject,occurred_at'
    )
    expect(lines.find((l) => l.includes(unlinkedSub))).toContain(
      `,issuer_attested,unlinked,${PROVIDER},${unlinkedSub},20`
    )
    expect(lines.find((l) => l.includes(formerSub))).toContain(
      `,issuer_attested,not_current_member,${PROVIDER},${formerSub},`
    )
    expect(lines.find((l) => l.includes(memberSub))).toContain(
      `,pv_verified,,${PROVIDER},${memberSub},`
    )
    const dataLines = lines
      .slice(1)
      .filter((l) => l !== '' && !l.startsWith('---') && !l.startsWith('rows_checked'))
    expect(dataLines.length).toBeGreaterThan(3)
    for (const line of dataLines) expect(line.split(',').length).toBe(13)
    const plain = dataLines.find((l) => !l.includes(MANIFEST_NAME) && l.includes('auth.'))
    if (plain) expect(plain.endsWith(',,,,,')).toBe(true)

    const verified = await withOrg(orgId, (tx) => verifyAuditRange(tx as Tx, { orgId, from, to }))
    expect(verified.failed).toEqual([])
  })
})
