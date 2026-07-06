import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditForwardingConfig, auditRetentionConfig } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  registerAndLoginViaApi,
  initVaultForTest,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createDirectAuthenticatedUser } from '../../__tests__/helpers/org-role-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { AUDIT_RETENTION_MAX_DAYS, AUDIT_RETENTION_MIN_DAYS } from './retention.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>
type Cookies = Record<string, string>

const TEST_PASSPHRASE = 'audit-forwarding-retention-routes-passphrase'
const PASSWORD = 'correct-horse-battery-staple'
const FORWARDING_URL = '/api/v1/org/audit/forwarding'
const RETENTION_URL = '/api/v1/org/audit/retention'
const PUBLIC_WEBHOOK_URL = 'https://1.1.1.1/ingest'

async function registerOwner(app: TestApp, label: string) {
  return registerAndLoginViaApi(app, {
    email: `${label}-${randomUUID()}@example.com`,
    password: PASSWORD,
    orgName: `${label} ${randomUUID()}`,
  })
}

async function putForwarding(app: TestApp, cookies: Cookies, body: unknown) {
  return app.inject({
    method: 'PUT',
    url: FORWARDING_URL,
    headers: { cookie: cookieHeader(cookies) },
    payload: body,
  })
}

async function putRetention(app: TestApp, cookies: Cookies, body: unknown) {
  return app.inject({
    method: 'PUT',
    url: RETENTION_URL,
    headers: { cookie: cookieHeader(cookies) },
    payload: body,
  })
}

describe.sequential('PUT /audit/forwarding', () => {
  let app: TestApp

  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
    app = await createApp({ logger: false, vaultGuardEnabled: true })
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('configures a webhook, never echoes the secret back (AC-17/AC-20)', async () => {
    const owner = await registerOwner(app, 'forwarding-happy')

    const res = await putForwarding(app, owner.cookies, {
      type: 'webhook',
      config: { url: 'https://93.184.216.34/ingest', secretHeader: 'wh_sec_9f3ac2' },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<{ data: { type: string; enabled: boolean; configuredAt: string } }>()
    expect(body.data).toMatchObject({ type: 'webhook', enabled: true })
    expect(JSON.stringify(res.json())).not.toContain('wh_sec_9f3ac2')
  })

  it('rejects SSRF-unsafe webhook URLs with 422 unsafe_forwarding_url (AC-17)', async () => {
    const owner = await registerOwner(app, 'forwarding-ssrf')

    const cases = [
      'http://compliance-siem.example.com/ingest', // non-https
      'https://127.0.0.1:8080/internal', // loopback
      'https://169.254.169.254/latest/meta-data/', // link-local
      'https://10.0.0.5/x', // RFC1918
      'https://172.16.0.1/x',
      'https://192.168.1.1/x',
    ]
    for (const url of cases) {
      const res = await putForwarding(app, owner.cookies, {
        type: 'webhook',
        config: { url, secretHeader: 'x'.repeat(8) },
      })
      expect(res.statusCode).toBe(422)
    }
  })

  it('accepts a normal public https webhook URL (control case, AC-17)', async () => {
    const owner = await registerOwner(app, 'forwarding-control')
    const res = await putForwarding(app, owner.cookies, {
      type: 'webhook',
      config: { url: PUBLIC_WEBHOOK_URL, secretHeader: 'wh_sec' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('rejects an S3 config whose endpoint is SSRF-unsafe (AC-17)', async () => {
    const owner = await registerOwner(app, 'forwarding-s3-ssrf')
    const res = await putForwarding(app, owner.cookies, {
      type: 's3',
      config: {
        bucket: 'compliance-bucket',
        region: 'us-east-1',
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
        endpoint: 'https://169.254.169.254/',
      },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ code: 'unsafe_forwarding_url' })
  })

  it('switching type replaces the config wholesale, clearing the prior type fields (AC-17)', async () => {
    const owner = await registerOwner(app, 'forwarding-switch')
    await putForwarding(app, owner.cookies, {
      type: 'webhook',
      config: { url: PUBLIC_WEBHOOK_URL, secretHeader: 'wh_sec' },
    })
    const res = await putForwarding(app, owner.cookies, {
      type: 's3',
      config: {
        bucket: 'compliance-bucket',
        region: 'us-east-1',
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
      },
    })
    expect(res.statusCode).toBe(200)
    const [row] = await withOrg(owner.orgId, (tx) =>
      tx.select().from(auditForwardingConfig).where(eq(auditForwardingConfig.orgId, owner.orgId))
    )
    expect(row?.type).toBe('s3')
    expect(row?.webhookUrl).toBeNull()
  })

  it('requires admin/owner role and MFA (AC-21)', async () => {
    const member = await createDirectAuthenticatedUser(app, 'member', 'member', 'forwarding-authz')
    const res = await putForwarding(app, member.cookies, {
      type: 'webhook',
      config: { url: PUBLIC_WEBHOOK_URL, secretHeader: 'x' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('writes an audit.forwarding_configured entry with type/enabled but never the secret (AC-18)', async () => {
    const owner = await registerOwner(app, 'forwarding-self-audit')
    await putForwarding(app, owner.cookies, {
      type: 'webhook',
      config: { url: PUBLIC_WEBHOOK_URL, secretHeader: 'wh_sec_should_not_appear' },
    })

    const { auditLogEntries } = await import('@project-vault/db/schema')
    const { sql } = await import('drizzle-orm')
    const rows = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ payload: auditLogEntries.payload })
        .from(auditLogEntries)
        .where(sql`${auditLogEntries.eventType} = 'audit.forwarding_configured'`)
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.payload).toMatchObject({ type: 'webhook', enabled: true })
    expect(JSON.stringify(rows[0]?.payload)).not.toContain('wh_sec_should_not_appear')
  })
})

describe.sequential('PUT /audit/retention', () => {
  let app: TestApp

  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
    app = await createApp({ logger: false, vaultGuardEnabled: true })
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('sets retentionDays (AC-22)', async () => {
    const owner = await registerOwner(app, 'retention-happy')
    const res = await putRetention(app, owner.cookies, { retentionDays: 365 })
    expect(res.statusCode).toBe(200)
    expect(res.json<{ data: { retentionDays: number } }>().data.retentionDays).toBe(365)

    const [row] = await withOrg(owner.orgId, (tx) =>
      tx.select().from(auditRetentionConfig).where(eq(auditRetentionConfig.orgId, owner.orgId))
    )
    expect(row?.retentionDays).toBe(365)
  })

  it(`rejects below the ${AUDIT_RETENTION_MIN_DAYS}-day floor (AC-22)`, async () => {
    const owner = await registerOwner(app, 'retention-floor')
    const res = await putRetention(app, owner.cookies, { retentionDays: 10 })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ code: 'validation_error' })
  })

  it(`rejects above the ${AUDIT_RETENTION_MAX_DAYS}-day ceiling (AC-22)`, async () => {
    const owner = await registerOwner(app, 'retention-ceiling')
    const res = await putRetention(app, owner.cookies, { retentionDays: 4000 })
    expect(res.statusCode).toBe(422)
  })

  it('accepts null as an explicit "retain forever" state (AC-22)', async () => {
    const owner = await registerOwner(app, 'retention-forever')
    const res = await putRetention(app, owner.cookies, { retentionDays: null })
    expect(res.statusCode).toBe(200)
    expect(res.json<{ data: { retentionDays: null } }>().data.retentionDays).toBeNull()
  })

  it('requires admin/owner role and MFA (AC-21)', async () => {
    const viewer = await createDirectAuthenticatedUser(app, 'viewer', 'viewer', 'retention-authz')
    const res = await putRetention(app, viewer.cookies, { retentionDays: 90 })
    expect(res.statusCode).toBe(403)
  })

  it('writes an audit.retention_configured entry (AC-22)', async () => {
    const owner = await registerOwner(app, 'retention-self-audit')
    await putRetention(app, owner.cookies, { retentionDays: 90 })

    const { auditLogEntries } = await import('@project-vault/db/schema')
    const { sql } = await import('drizzle-orm')
    const rows = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ payload: auditLogEntries.payload })
        .from(auditLogEntries)
        .where(sql`${auditLogEntries.eventType} = 'audit.retention_configured'`)
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.payload).toMatchObject({ retentionDays: 90 })
  })
})
