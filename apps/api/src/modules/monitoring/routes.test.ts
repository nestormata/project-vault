import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { insertTestProject } from '@project-vault/db/test-helpers'
import {
  auditLogEntries,
  notificationQueue,
  paymentRecords,
  certRecords,
  domainRecords,
} from '@project-vault/db/schema'
import {
  cookieHeader,
  createProjectViaApi,
  expectAuditWriteFailed,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { bootstrapCredentialRouteOwners } from '../credentials/credential-route-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { monitoringIntegration } from './monitoring-integration-context.js'

const { createApp, initVault, humanAudit } = monitoringIntegration
type TestApp = Awaited<ReturnType<typeof createApp>>
type Cookies = Record<string, string>

const TEST_PASSPHRASE = 'monitoring-routes-passphrase'
const PASSWORD = 'correct-horse-battery-staple'
const FUTURE_ISO = new Date(Date.now() + 90 * 86_400_000).toISOString()

type ResourceFixture = {
  key: 'services' | 'certificates' | 'domains'
  idParam: string
  auditPrefix: 'payment_record' | 'certificate' | 'domain_record'
  notFoundCode: string
  happyBody: Record<string, unknown>
  minimalBody: Record<string, unknown>
  defaultAlertLeadDays: number[]
  expiryField: 'renewalDate' | 'expiresAt'
  identifyingField: 'name' | 'domain' | 'domainName'
  table: typeof paymentRecords | typeof certRecords | typeof domainRecords
}

const RESOURCES: ResourceFixture[] = [
  {
    key: 'services',
    idParam: 'serviceId',
    auditPrefix: 'payment_record',
    notFoundCode: 'service_not_found',
    happyBody: {
      name: 'AWS Hosting',
      url: 'https://console.aws.amazon.com/billing',
      renewalDate: FUTURE_ISO,
    },
    minimalBody: { name: 'GitHub SaaS seat' },
    defaultAlertLeadDays: [14, 3],
    expiryField: 'renewalDate',
    identifyingField: 'name',
    table: paymentRecords,
  },
  {
    key: 'certificates',
    idParam: 'certificateId',
    auditPrefix: 'certificate',
    notFoundCode: 'certificate_not_found',
    happyBody: { domain: 'api.example.com', expiresAt: FUTURE_ISO },
    minimalBody: { domain: 'minimal.example.com', expiresAt: FUTURE_ISO },
    defaultAlertLeadDays: [30, 7],
    expiryField: 'expiresAt',
    identifyingField: 'domain',
    table: certRecords,
  },
  {
    key: 'domains',
    idParam: 'domainId',
    auditPrefix: 'domain_record',
    notFoundCode: 'domain_record_not_found',
    happyBody: { domainName: 'example.com', renewalDate: FUTURE_ISO },
    minimalBody: { domainName: 'minimal-example.com', renewalDate: FUTURE_ISO },
    defaultAlertLeadDays: [30],
    expiryField: 'renewalDate',
    identifyingField: 'domainName',
    table: domainRecords,
  },
]

function baseUrl(projectId: string, resource: ResourceFixture): string {
  return `/api/v1/projects/${projectId}/${resource.key}`
}

function itemUrl(projectId: string, resource: ResourceFixture, id: string): string {
  return `${baseUrl(projectId, resource)}/${id}`
}

function createRecord(
  app: TestApp,
  cookies: Cookies,
  projectId: string,
  resource: ResourceFixture,
  body: Record<string, unknown> = resource.happyBody
) {
  return app.inject({
    method: 'POST',
    url: baseUrl(projectId, resource),
    headers: { cookie: cookieHeader(cookies) },
    payload: body,
  })
}

async function createRecordExpect201(
  app: TestApp,
  cookies: Cookies,
  projectId: string,
  resource: ResourceFixture,
  body: Record<string, unknown> = resource.happyBody
) {
  const res = await createRecord(app, cookies, projectId, resource, body)
  expect(res.statusCode).toBe(201)
  return res.json<{ data: { id: string; [key: string]: unknown } }>().data
}

function patchRecord(
  app: TestApp,
  cookies: Cookies,
  projectId: string,
  resource: ResourceFixture,
  id: string,
  body: Record<string, unknown>
) {
  return app.inject({
    method: 'PATCH',
    url: itemUrl(projectId, resource, id),
    headers: { cookie: cookieHeader(cookies) },
    payload: body,
  })
}

function deleteRecord(
  app: TestApp,
  cookies: Cookies,
  projectId: string,
  resource: ResourceFixture,
  id: string
) {
  return app.inject({
    method: 'DELETE',
    url: itemUrl(projectId, resource, id),
    headers: { cookie: cookieHeader(cookies) },
  })
}

function listRecords(app: TestApp, cookies: Cookies, projectId: string, resource: ResourceFixture) {
  return app.inject({
    method: 'GET',
    url: baseUrl(projectId, resource),
    headers: { cookie: cookieHeader(cookies) },
  })
}

describe('monitoring routes (services/certificates/domains)', () => {
  let app: TestApp
  let owner: { userId: string; orgId: string; cookies: Cookies }
  let other: { userId: string; orgId: string; cookies: Cookies }
  const { addUserToOrg } = createMembershipTestHelpers({
    emailPrefix: 'monitoring-get',
    orgNamePrefix: 'MonitoringGet',
  })

  beforeAll(async () => {
    const bootstrap = await bootstrapCredentialRouteOwners(
      createApp,
      initVault,
      TEST_PASSPHRASE,
      PASSWORD,
      'monitoring'
    )
    app = bootstrap.app
    owner = bootstrap.owner
    other = bootstrap.other
  }, 30_000)

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  describe.each(RESOURCES)('POST $key', (resource) => {
    it('creates a record with defaults applied (happy path)', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, `${resource.key}-happy`)
      const data = await createRecordExpect201(app, owner.cookies, projectId, resource)

      expect(data).toMatchObject({
        [resource.identifyingField]: resource.happyBody[resource.identifyingField],
        alertLeadDays: resource.defaultAlertLeadDays,
        notifiedLeadDays: [],
        projectId,
      })
      expect(data[resource.expiryField]).toBeTruthy()
    })

    it('creates a record with omitted optional fields defaulted (edge path)', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, `${resource.key}-edge`)
      const res = await createRecord(app, owner.cookies, projectId, resource, resource.minimalBody)
      expect(res.statusCode).toBe(201)
      const data = res.json<{ data: Record<string, unknown> }>().data
      expect(data['alertLeadDays']).toEqual(resource.defaultAlertLeadDays)
      expect(data['notifiedLeadDays']).toEqual([])
      if (resource.key === 'services') {
        expect(data['url']).toBeNull()
        expect(data['renewalDate']).toBeNull()
      }
    })

    it('rejects missing identifying field and oversized alertLeadDays with 422', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, `${resource.key}-invalid`)

      const missingField = { ...resource.happyBody }
      Reflect.deleteProperty(missingField, resource.identifyingField)
      const missingRes = await createRecord(app, owner.cookies, projectId, resource, missingField)
      expect(missingRes.statusCode).toBe(422)

      const tooManyLeadDays = await createRecord(app, owner.cookies, projectId, resource, {
        ...resource.happyBody,
        alertLeadDays: Array.from({ length: 11 }, (_, i) => i + 1),
      })
      expect(tooManyLeadDays.statusCode).toBe(422)

      const negativeLeadDays = await createRecord(app, owner.cookies, projectId, resource, {
        ...resource.happyBody,
        alertLeadDays: [-1],
      })
      expect(negativeLeadDays.statusCode).toBe(422)
    })

    it('returns 404 project_not_found for a project outside the caller org', async () => {
      const otherProjectId = await createProjectViaApi(
        app,
        other.cookies,
        `${resource.key}-cross-org`
      )
      const res = await createRecord(app, owner.cookies, otherProjectId, resource)
      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ code: 'project_not_found' })
    })

    it('returns 410 for an archived project', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, `${resource.key}-archived`)
      const archiveRes = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/archive`,
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect(archiveRes.statusCode).toBe(200)

      const res = await createRecord(app, owner.cookies, projectId, resource)
      expect(res.statusCode).toBe(410)
    })

    it('writes a created audit event in the same transaction', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, `${resource.key}-audit`)
      const data = await createRecordExpect201(app, owner.cookies, projectId, resource)

      const rows = await withOrg(owner.orgId, (tx) =>
        tx
          .select({ resourceId: auditLogEntries.resourceId })
          .from(auditLogEntries)
          .where(eq(auditLogEntries.eventType, `${resource.auditPrefix}.created`))
      )
      expect(rows.some((row) => row.resourceId === data['id'])).toBe(true)
    })

    it('rolls back creation when the audit write fails', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, `${resource.key}-audit-fail`)
      const auditSpy = vi
        .spyOn(humanAudit, 'writeHumanAuditEntry')
        .mockRejectedValueOnce(new Error('forced audit failure'))
      try {
        const res = await createRecord(app, owner.cookies, projectId, resource)
        expectAuditWriteFailed(res)
      } finally {
        auditSpy.mockRestore()
      }
    })
  })

  describe.each(RESOURCES)('PATCH $key/:id', (resource) => {
    it('updates the expiry field and resets notifiedLeadDays to []', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, `${resource.key}-patch`)
      const created = await createRecordExpect201(app, owner.cookies, projectId, resource)

      // Force notifiedLeadDays to a non-empty value directly so we can assert the reset.
      await withOrg(owner.orgId, (tx) =>
        tx
          .update(resource.table)
          .set({ notifiedLeadDays: [30] })
          .where(eq(resource.table.id, created['id'] as string))
      )

      const newDate = new Date(Date.now() + 200 * 86_400_000).toISOString()
      const res = await patchRecord(
        app,
        owner.cookies,
        projectId,
        resource,
        created['id'] as string,
        {
          [resource.expiryField]: newDate,
        }
      )
      expect(res.statusCode).toBe(200)
      const data = res.json<{ data: Record<string, unknown> }>().data
      expect(data['notifiedLeadDays']).toEqual([])
      expect(data[resource.expiryField]).toBe(newDate)
    })

    it('returns 404 for a record in a different project/org', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, `${resource.key}-patch-404`)
      const created = await createRecordExpect201(app, owner.cookies, projectId, resource)

      const otherProjectId = await createProjectViaApi(
        app,
        other.cookies,
        `${resource.key}-patch-cross-org`
      )
      const crossOrgRes = await patchRecord(
        app,
        other.cookies,
        otherProjectId,
        resource,
        created['id'] as string,
        { alertLeadDays: [5] }
      )
      expect(crossOrgRes.statusCode).toBe(404)
      expect(crossOrgRes.json()).toMatchObject({ code: resource.notFoundCode })
    })

    it('writes an updated audit event', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, `${resource.key}-patch-audit`)
      const created = await createRecordExpect201(app, owner.cookies, projectId, resource)

      const res = await patchRecord(
        app,
        owner.cookies,
        projectId,
        resource,
        created['id'] as string,
        {
          alertLeadDays: [5],
        }
      )
      expect(res.statusCode).toBe(200)

      const rows = await withOrg(owner.orgId, (tx) =>
        tx
          .select({ resourceId: auditLogEntries.resourceId })
          .from(auditLogEntries)
          .where(eq(auditLogEntries.eventType, `${resource.auditPrefix}.updated`))
      )
      expect(rows.some((row) => row.resourceId === created['id'])).toBe(true)
    })

    it('treats an empty body as a no-op and returns the record unchanged (200, not a DB error)', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, `${resource.key}-patch-empty`)
      const created = await createRecordExpect201(app, owner.cookies, projectId, resource)

      const res = await patchRecord(
        app,
        owner.cookies,
        projectId,
        resource,
        created['id'] as string,
        {}
      )
      expect(res.statusCode).toBe(200)
      const data = res.json<{ data: Record<string, unknown> }>().data
      expect(data['id']).toBe(created['id'])
      expect(data['alertLeadDays']).toEqual(created['alertLeadDays'])
      expect(data['notifiedLeadDays']).toEqual(created['notifiedLeadDays'])
    })
  })

  describe.each(RESOURCES)('DELETE $key/:id', (resource) => {
    it('hard-deletes the row, suppresses pending notifications, and writes an audit snapshot', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, `${resource.key}-delete`)
      const created = await createRecordExpect201(app, owner.cookies, projectId, resource)

      const [pendingA, pendingB] = await withOrg(owner.orgId, (tx) =>
        tx
          .insert(notificationQueue)
          .values([
            {
              orgId: owner.orgId,
              channel: 'email',
              templateId: `${resource.key === 'services' ? 'payment' : resource.key === 'certificates' ? 'certificate' : 'domain'}.expiry`,
              payload: { assetId: created['id'] },
              status: 'pending',
            },
            {
              orgId: owner.orgId,
              channel: 'inbox',
              templateId: `${resource.key === 'services' ? 'payment' : resource.key === 'certificates' ? 'certificate' : 'domain'}.expiry`,
              payload: { assetId: created['id'] },
              status: 'pending',
            },
          ])
          .returning({ id: notificationQueue.id })
      )
      expect(pendingA).toBeDefined()
      expect(pendingB).toBeDefined()
      if (!pendingA || !pendingB) return

      const res = await deleteRecord(
        app,
        owner.cookies,
        projectId,
        resource,
        created['id'] as string
      )
      expect(res.statusCode).toBe(204)

      const remaining = await withOrg(owner.orgId, (tx) =>
        tx
          .select()
          .from(resource.table)
          .where(eq(resource.table.id, created['id'] as string))
      )
      expect(remaining).toHaveLength(0)

      const suppressed = await withOrg(owner.orgId, (tx) =>
        tx
          .select({ id: notificationQueue.id, status: notificationQueue.status })
          .from(notificationQueue)
          .where(
            and(eq(notificationQueue.id, pendingA.id), eq(notificationQueue.status, 'suppressed'))
          )
      )
      expect(suppressed).toHaveLength(1)
      const suppressedB = await withOrg(owner.orgId, (tx) =>
        tx
          .select({ id: notificationQueue.id, status: notificationQueue.status })
          .from(notificationQueue)
          .where(
            and(eq(notificationQueue.id, pendingB.id), eq(notificationQueue.status, 'suppressed'))
          )
      )
      expect(suppressedB).toHaveLength(1)

      const auditRows = await withOrg(owner.orgId, (tx) =>
        tx
          .select({ resourceId: auditLogEntries.resourceId, payload: auditLogEntries.payload })
          .from(auditLogEntries)
          .where(eq(auditLogEntries.eventType, `${resource.auditPrefix}.deleted`))
      )
      const deletedAudit = auditRows.find((row) => row.resourceId === created['id'])
      expect(deletedAudit).toBeDefined()
      expect((deletedAudit?.payload as Record<string, unknown>)[resource.identifyingField]).toBe(
        resource.happyBody[resource.identifyingField]
      )
    })

    it('returns 404 for a record that does not exist in the project', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, `${resource.key}-delete-404`)
      const res = await deleteRecord(app, owner.cookies, projectId, resource, randomUUID())
      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ code: resource.notFoundCode })
    })
  })

  describe.each(RESOURCES)('RLS isolation for $key', (resource) => {
    it('hides a cross-org record as 404 (not 403) on read/update/delete', async () => {
      const project = await insertTestProject(owner.orgId, {
        userId: owner.userId,
        slug: `${resource.key}-rls`,
      })
      const created = await createRecordExpect201(app, owner.cookies, project.id, resource)

      const otherProjectId = await createProjectViaApi(
        app,
        other.cookies,
        `${resource.key}-rls-other`
      )

      const patchRes = await patchRecord(
        app,
        other.cookies,
        otherProjectId,
        resource,
        created['id'] as string,
        { alertLeadDays: [5] }
      )
      expect(patchRes.statusCode).toBe(404)

      const deleteRes = await deleteRecord(
        app,
        other.cookies,
        otherProjectId,
        resource,
        created['id'] as string
      )
      expect(deleteRes.statusCode).toBe(404)

      // Confirm the row is genuinely still present under the owner's org (RLS hid it, didn't
      // delete it — proves 404 came from tenant isolation, not row absence).
      const stillExists = await withOrg(owner.orgId, (tx) =>
        tx
          .select()
          .from(resource.table)
          .where(eq(resource.table.id, created['id'] as string))
      )
      expect(stillExists).toHaveLength(1)
    })
  })

  describe.each(RESOURCES)('GET $key/:id', (resource) => {
    it('returns the record (200, same shape as list/create)', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, `${resource.key}-get`)
      const created = await createRecordExpect201(app, owner.cookies, projectId, resource)

      const res = await app.inject({
        method: 'GET',
        url: itemUrl(projectId, resource, created['id'] as string),
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect(res.statusCode).toBe(200)
      const data = res.json<{ data: Record<string, unknown> }>().data
      expect(data['id']).toBe(created['id'])
      expect(data[resource.identifyingField]).toBe(resource.happyBody[resource.identifyingField])
    })

    it('returns 404 for an id that does not exist in the project', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, `${resource.key}-get-404`)
      const res = await app.inject({
        method: 'GET',
        url: itemUrl(projectId, resource, randomUUID()),
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ code: resource.notFoundCode })
    })

    it('hides a cross-org record as 404 (not 403)', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, `${resource.key}-get-cross`)
      const created = await createRecordExpect201(app, owner.cookies, projectId, resource)

      const otherProjectId = await createProjectViaApi(
        app,
        other.cookies,
        `${resource.key}-get-cross-other`
      )
      const res = await app.inject({
        method: 'GET',
        url: itemUrl(otherProjectId, resource, created['id'] as string),
        headers: { cookie: cookieHeader(other.cookies) },
      })
      expect(res.statusCode).toBe(404)
    })

    it('hides a same-org, different-project record as 404 (query filters by projectId)', async () => {
      const projectId = await createProjectViaApi(
        app,
        owner.cookies,
        `${resource.key}-get-other-project-a`
      )
      const created = await createRecordExpect201(app, owner.cookies, projectId, resource)

      const otherProjectId = await createProjectViaApi(
        app,
        owner.cookies,
        `${resource.key}-get-other-project-b`
      )
      const res = await app.inject({
        method: 'GET',
        url: itemUrl(otherProjectId, resource, created['id'] as string),
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect(res.statusCode).toBe(404)
    })

    it('allows an org viewer to read (same minimumRole as the list route, looser than PATCH/DELETE)', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, `${resource.key}-get-viewer`)
      const created = await createRecordExpect201(app, owner.cookies, projectId, resource)
      const viewer = await addUserToOrg(app, owner.orgId, `${resource.key}-viewer`, {
        orgRole: 'viewer',
      })

      const res = await app.inject({
        method: 'GET',
        url: itemUrl(projectId, resource, created['id'] as string),
        headers: { cookie: cookieHeader(viewer.cookies) },
      })
      expect(res.statusCode).toBe(200)
    })
  })

  describe.each(RESOURCES)('GET $key (list)', (resource) => {
    it('lists records scoped to the project', async () => {
      const projectId = await createProjectViaApi(app, owner.cookies, `${resource.key}-list`)
      await createRecordExpect201(app, owner.cookies, projectId, resource)
      await createRecordExpect201(app, owner.cookies, projectId, resource, resource.minimalBody)

      const res = await listRecords(app, owner.cookies, projectId, resource)
      expect(res.statusCode).toBe(200)
      const items = res.json<{ data: { items: unknown[] } }>().data.items
      expect(items.length).toBeGreaterThanOrEqual(2)
    })
  })
})
