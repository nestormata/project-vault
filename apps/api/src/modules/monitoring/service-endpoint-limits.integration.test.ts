import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import { organizations, serviceEndpoints } from '@project-vault/db/schema'
import { createTestUser, deleteTestUser, insertTestProject } from '@project-vault/db/test-helpers'
import {
  configureAuthIntegrationEnv,
  initVaultForTest,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import {
  CheckIntervalTooShortError,
  HealthChecksDisabledError,
  ServiceEndpointLimitsUnavailableError,
  __resetServiceEndpointLimitsForTests,
  __setServiceEndpointLimitsResolverForTests,
  __setStaticServiceEndpointLimitsForTests,
} from '../../lib/service-endpoint-limits.js'
import {
  ServiceEndpointLimitReachedError,
  createServiceEndpoint,
  updateServiceEndpoint,
} from './service.js'

configureAuthIntegrationEnv()

const { initVault } = await import('../vault/key-service.js')

const TEST_PASSPHRASE = 'service-endpoint-limits-integration-passphrase'
const TEST_URL = 'https://example.com/health'

async function createTestOrg(label: string): Promise<string> {
  const orgName = `Selimits ${label} ${randomUUID()}`
  const [org] = await getDb()
    .insert(organizations)
    .values({ name: orgName, slug: orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-') })
    .returning({ id: organizations.id })
  if (!org) throw new Error('createTestOrg: insert returned no row')
  return org.id
}

describe('service-endpoint limits enforcement (Story 73.7)', () => {
  beforeAll(async () => {
    await initVaultForTest(initVault, TEST_PASSPHRASE)
  })

  afterEach(() => {
    __resetServiceEndpointLimitsForTests()
  })

  afterAll(async () => {
    await resetVaultForTest()
  })

  it('default-open create and 1-minute update succeed under the per-project cap', async () => {
    const orgId = await createTestOrg('open')
    const userId = await createTestUser('selimits-open')
    try {
      const project = await insertTestProject(orgId, {
        userId,
        slug: `selimits-open-${randomUUID().slice(0, 8)}`,
      })
      const row = await withOrg(orgId, (tx) =>
        createServiceEndpoint(tx, {
          orgId,
          projectId: project.id,
          userId,
          body: { name: 'open', url: TEST_URL, checkFrequencyMinutes: 5 },
        })
      )
      const updated = await withOrg(orgId, (tx) =>
        updateServiceEndpoint(tx, {
          serviceEndpointId: row.id,
          projectId: project.id,
          userId,
          body: { checkFrequencyMinutes: 1 },
          rawBody: { checkFrequencyMinutes: 1 },
        })
      )
      expect(updated?.row.checkFrequencyMinutes).toBe(1)
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('restricted static config refuses create, resume, short interval, and org-cap create', async () => {
    const orgId = await createTestOrg('restricted')
    const userId = await createTestUser('selimits-restricted')
    try {
      const project = await insertTestProject(orgId, {
        userId,
        slug: `selimits-restr-${randomUUID().slice(0, 8)}`,
      })
      __setStaticServiceEndpointLimitsForTests({ healthChecksEnabled: false })
      await expect(
        withOrg(orgId, (tx) =>
          createServiceEndpoint(tx, {
            orgId,
            projectId: project.id,
            userId,
            body: { name: 'blocked', url: TEST_URL },
          })
        )
      ).rejects.toBeInstanceOf(HealthChecksDisabledError)

      __resetServiceEndpointLimitsForTests()
      const live = await withOrg(orgId, (tx) =>
        createServiceEndpoint(tx, {
          orgId,
          projectId: project.id,
          userId,
          body: { name: 'live', url: TEST_URL, checkFrequencyMinutes: 5 },
        })
      )
      await withOrg(orgId, (tx) =>
        updateServiceEndpoint(tx, {
          serviceEndpointId: live.id,
          projectId: project.id,
          userId,
          body: { healthCheckPaused: true },
          rawBody: { healthCheckPaused: true },
        })
      )
      __setStaticServiceEndpointLimitsForTests({ healthChecksEnabled: false })
      await expect(
        withOrg(orgId, (tx) =>
          updateServiceEndpoint(tx, {
            serviceEndpointId: live.id,
            projectId: project.id,
            userId,
            body: { healthCheckPaused: false },
            rawBody: { healthCheckPaused: false },
          })
        )
      ).rejects.toBeInstanceOf(HealthChecksDisabledError)

      __setStaticServiceEndpointLimitsForTests({ minCheckIntervalSeconds: 600 })
      await expect(
        withOrg(orgId, (tx) =>
          updateServiceEndpoint(tx, {
            serviceEndpointId: live.id,
            projectId: project.id,
            userId,
            body: { checkFrequencyMinutes: 5 },
            rawBody: { checkFrequencyMinutes: 5 },
          })
        )
      ).rejects.toBeInstanceOf(CheckIntervalTooShortError)

      __setStaticServiceEndpointLimitsForTests({ maxEndpoints: 1 })
      await expect(
        withOrg(orgId, (tx) =>
          createServiceEndpoint(tx, {
            orgId,
            projectId: project.id,
            userId,
            body: { name: 'second', url: 'https://example.net/health' },
          })
        )
      ).rejects.toMatchObject({
        name: 'ServiceEndpointLimitReachedError',
        code: 'service_endpoint_limit_reached',
        message: 'This organization has reached its maximum of 1 monitored endpoints',
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('a throwing resolver fail-closes create and allows a lowering update', async () => {
    const orgId = await createTestOrg('fail-closed')
    const userId = await createTestUser('selimits-fail-closed')
    try {
      const project = await insertTestProject(orgId, {
        userId,
        slug: `selimits-fail-${randomUUID().slice(0, 8)}`,
      })
      const live = await withOrg(orgId, (tx) =>
        createServiceEndpoint(tx, {
          orgId,
          projectId: project.id,
          userId,
          body: { name: 'live', url: TEST_URL, checkFrequencyMinutes: 1 },
        })
      )
      __setServiceEndpointLimitsResolverForTests({
        onResolveServiceEndpointLimits: async () => {
          throw new Error('resolver down')
        },
      })
      await expect(
        withOrg(orgId, (tx) =>
          createServiceEndpoint(tx, {
            orgId,
            projectId: project.id,
            userId,
            body: { name: 'nope', url: 'https://example.org/health' },
          })
        )
      ).rejects.toBeInstanceOf(ServiceEndpointLimitsUnavailableError)

      const lowered = await withOrg(orgId, (tx) =>
        updateServiceEndpoint(tx, {
          serviceEndpointId: live.id,
          projectId: project.id,
          userId,
          body: { checkFrequencyMinutes: 15 },
          rawBody: { checkFrequencyMinutes: 15 },
        })
      )
      expect(lowered?.row.checkFrequencyMinutes).toBe(15)
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('parallel creates cannot exceed the org cap', async () => {
    const orgId = await createTestOrg('parallel')
    const userId = await createTestUser('selimits-parallel')
    try {
      const project = await insertTestProject(orgId, {
        userId,
        slug: `selimits-par-${randomUUID().slice(0, 8)}`,
      })
      __setStaticServiceEndpointLimitsForTests({ maxEndpoints: 1 })
      const results = await Promise.allSettled([
        withOrg(orgId, (tx) =>
          createServiceEndpoint(tx, {
            orgId,
            projectId: project.id,
            userId,
            body: { name: 'a', url: 'https://example.com/a' },
          })
        ),
        withOrg(orgId, (tx) =>
          createServiceEndpoint(tx, {
            orgId,
            projectId: project.id,
            userId,
            body: { name: 'b', url: 'https://example.com/b' },
          })
        ),
      ])
      const fulfilled = results.filter((r) => r.status === 'fulfilled')
      const rejected = results.filter((r) => r.status === 'rejected')
      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      expect(rejected[0]?.status === 'rejected' && rejected[0].reason).toBeInstanceOf(
        ServiceEndpointLimitReachedError
      )
      const rows = await withOrg(orgId, (tx) =>
        tx.select().from(serviceEndpoints).where(eq(serviceEndpoints.orgId, orgId))
      )
      expect(rows).toHaveLength(1)
    } finally {
      await deleteTestUser(userId)
    }
  })
})
