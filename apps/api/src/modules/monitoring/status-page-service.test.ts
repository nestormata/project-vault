import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const PAYMENTS_API_DISPLAY_NAME = 'Payments API'
const TEST_PASSPHRASE = 'status-page-service-passphrase'
import { eq } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { serviceEndpoints, statusPages } from '@project-vault/db/schema'
import {
  createTestUser,
  deleteTestUser,
  insertTestProject,
  withTestOrg,
} from '@project-vault/db/test-helpers'
import {
  configureAuthIntegrationEnv,
  initVaultForTest,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { initVault, unsealVault, zeroKeys } from '../vault/key-service.js'
import {
  disableStatusPage,
  enableStatusPage,
  findStatusPageByProject,
  getStatusPageConfig,
  InvalidServiceReferenceError,
  regenerateStatusPageToken,
  StatusPageAlreadyEnabledError,
  StatusPageNotFoundError,
  updateStatusPageServices,
} from './status-page-service.js'

/**
 * The test user is created *before* and deleted *after* `withTestOrg`'s transaction — not inside
 * its callback's `finally` — because `enableStatusPage` inserts a `status_pages` row with
 * `createdBy: userId` through the shared, still-open outer `tx`. If `deleteTestUser` (its own,
 * separate connection) ran while that insert's transaction is still uncommitted, Postgres's
 * `ON DELETE SET NULL` cascade check on `status_pages` would have to wait for the outer
 * transaction to resolve before it can safely scan for referencing rows — a genuine Postgres-level
 * deadlock (confirmed via pg_stat_activity/pg_blocking_pids while diagnosing this), not a bug in
 * the code under test. `insertTestProject` avoids this itself by committing its own insert in a
 * dedicated mini-transaction before returning.
 */
async function withProjectAndEndpoint(
  run: (ctx: {
    orgId: string
    tx: Tx
    projectId: string
    userId: string
    endpointId: string
  }) => Promise<void>
) {
  const userId = await createTestUser('status-page')
  try {
    await withTestOrg(async ({ orgId, tx }) => {
      const project = await insertTestProject(orgId, { userId, slug: 'status-page' })
      const [endpoint] = await tx
        .insert(serviceEndpoints)
        .values({
          orgId,
          projectId: project.id,
          name: 'svc',
          url: 'https://svc.example.com/health',
          status: 'healthy',
        })
        .returning()
      if (!endpoint) throw new Error('expected service endpoint to be inserted')
      await run({ orgId, tx, projectId: project.id, userId, endpointId: endpoint.id })
    })
  } finally {
    await deleteTestUser(userId)
  }
}

// .sequential: this suite mutates the process-wide vault key-service singleton (zeroKeys()/
// unsealVault() in the VAULT_SEALED_ON_READ test) — matches the established convention for every
// other vault-singleton-mutating suite in this codebase (see vault-lifecycle.test.ts,
// backup-key.test.ts, etc.) to prevent cross-test interference.
describe.sequential('status-page-service', () => {
  beforeAll(async () => {
    configureAuthIntegrationEnv()
    await resetVaultForTest()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
  })

  afterAll(async () => {
    await resetVaultForTest()
  })

  describe('enableStatusPage', () => {
    it('creates a status_pages row and returns a one-time plaintext token (AC 8)', async () => {
      await withProjectAndEndpoint(async ({ orgId, tx, projectId, userId }) => {
        const result = await enableStatusPage(tx, { orgId, projectId, userId })
        expect(result.token).toMatch(/^[A-Za-z0-9_-]+$/)
        expect(result.token.length).toBeGreaterThan(32)

        const row = await findStatusPageByProject(tx, projectId)
        expect(row?.tokenHash).not.toBe(result.token)
      })
    })

    it('maps a concurrent duplicate enable to StatusPageAlreadyEnabledError, not a raw 500 (AC 8 concurrency)', async () => {
      await withProjectAndEndpoint(async ({ orgId, tx, projectId, userId }) => {
        await enableStatusPage(tx, { orgId, projectId, userId })
        await expect(enableStatusPage(tx, { orgId, projectId, userId })).rejects.toThrow(
          StatusPageAlreadyEnabledError
        )
      })
    })

    it('stores the token as a decryptable encryptedToken + keyVersion alongside tokenHash (Story 21.7)', async () => {
      await withProjectAndEndpoint(async ({ orgId, tx, projectId, userId }) => {
        await enableStatusPage(tx, { orgId, projectId, userId })
        const row = await findStatusPageByProject(tx, projectId)
        expect(row?.encryptedToken).not.toBeNull()
        expect(row?.keyVersion).toBe(1)
      })
    })
  })

  describe('regenerateStatusPageToken', () => {
    it('replaces the token hash and invalidates the old token (AC 11)', async () => {
      await withProjectAndEndpoint(async ({ orgId, tx, projectId, userId }) => {
        const enabled = await enableStatusPage(tx, { orgId, projectId, userId })
        const regenerated = await regenerateStatusPageToken(tx, projectId)

        expect(regenerated.token).not.toBe(enabled.token)
        const row = await findStatusPageByProject(tx, projectId)
        expect(row?.id).toBe(enabled.id)
      })
    })

    it('throws StatusPageNotFoundError when no status page exists yet', async () => {
      await withProjectAndEndpoint(async ({ tx, projectId }) => {
        await expect(regenerateStatusPageToken(tx, projectId)).rejects.toThrow(
          StatusPageNotFoundError
        )
      })
    })

    it('rotates tokenHash and encryptedToken together, atomically (Story 21.7)', async () => {
      await withProjectAndEndpoint(async ({ orgId, tx, projectId, userId }) => {
        await enableStatusPage(tx, { orgId, projectId, userId })
        const before = await findStatusPageByProject(tx, projectId)

        const regenerated = await regenerateStatusPageToken(tx, projectId)

        const after = await findStatusPageByProject(tx, projectId)
        expect(after?.tokenHash).not.toBe(before?.tokenHash)
        expect(JSON.stringify(after?.encryptedToken)).not.toBe(
          JSON.stringify(before?.encryptedToken)
        )

        const config = await getStatusPageConfig(tx, projectId)
        expect(config.token).toBe(regenerated.token)
      })
    })
  })

  describe('getStatusPageConfig (AC 21)', () => {
    it('returns { enabled: false } when no status page exists yet', async () => {
      await withProjectAndEndpoint(async ({ tx, projectId }) => {
        const config = await getStatusPageConfig(tx, projectId)
        expect(config).toEqual({ enabled: false })
      })
    })

    it('returns the current configuration once enabled and services are set', async () => {
      await withProjectAndEndpoint(async ({ orgId, tx, projectId, userId, endpointId }) => {
        await enableStatusPage(tx, { orgId, projectId, userId })
        await updateStatusPageServices(tx, {
          orgId,
          projectId,
          body: { services: [{ serviceId: endpointId, displayName: PAYMENTS_API_DISPLAY_NAME }] },
        })

        const config = await getStatusPageConfig(tx, projectId)
        expect(config.enabled).toBe(true)
        expect(config.services).toEqual([
          { serviceId: endpointId, displayName: PAYMENTS_API_DISPLAY_NAME, sortOrder: 0 },
        ])
      })
    })

    it('returns the same token via GET after enable, without regenerating (Story 21.7 HAPPY_PATH_NEW)', async () => {
      await withProjectAndEndpoint(async ({ orgId, tx, projectId, userId }) => {
        const enabled = await enableStatusPage(tx, { orgId, projectId, userId })

        const config = await getStatusPageConfig(tx, projectId)
        expect(config.token).toBe(enabled.token)
      })
    })

    it('omits token for a legacy row with no encryptedToken (Story 21.7 LEGACY_ROW)', async () => {
      await withProjectAndEndpoint(async ({ orgId, tx, projectId, userId }) => {
        await enableStatusPage(tx, { orgId, projectId, userId })
        // Simulate a pre-21.7 row by clearing the columns this migration added.
        await tx
          .update(statusPages)
          .set({ encryptedToken: null, keyVersion: null })
          .where(eq(statusPages.projectId, projectId))

        const config = await getStatusPageConfig(tx, projectId)
        expect(config.enabled).toBe(true)
        expect(config.token).toBeUndefined()
        // Story 6.6 AC-4: a genuine legacy row (encryptedToken column is null) is flagged so the
        // UI can offer the honest "cannot be reconstructed, migrate" copy instead of the neutral
        // sealed-vault fallback.
        expect(config.legacyToken).toBe(true)
      })
    })

    it('omits token instead of throwing when the vault is sealed at read time (Story 21.7 VAULT_SEALED_ON_READ)', async () => {
      await withProjectAndEndpoint(async ({ orgId, tx, projectId, userId }) => {
        await enableStatusPage(tx, { orgId, projectId, userId })

        zeroKeys()
        try {
          const config = await getStatusPageConfig(tx, projectId)
          expect(config.enabled).toBe(true)
          expect(config.token).toBeUndefined()
          // Story 6.6 AC-4: the sealed-vault case has a recoverable ciphertext, just not right
          // now — it must stay distinguishable from the genuine legacy-row case above.
          expect(config.legacyToken).toBeFalsy()
        } finally {
          await unsealVault({ passphrase: TEST_PASSPHRASE })
        }
      })
    })
  })

  describe('updateStatusPageServices (AC 15)', () => {
    it('replaces the full service set atomically and returns a previous-state snapshot (AC 17)', async () => {
      await withProjectAndEndpoint(async ({ orgId, tx, projectId, userId, endpointId }) => {
        await enableStatusPage(tx, { orgId, projectId, userId })
        await updateStatusPageServices(tx, {
          orgId,
          projectId,
          body: { services: [{ serviceId: endpointId, displayName: 'First name' }] },
        })

        const result = await updateStatusPageServices(tx, {
          orgId,
          projectId,
          body: { services: [{ serviceId: endpointId, displayName: 'Second name' }] },
        })

        expect(result.previous).toEqual({ count: 1, displayNames: ['First name'] })
        expect(result.services).toEqual([
          { serviceId: endpointId, displayName: 'Second name', sortOrder: 0 },
        ])
      })
    })

    it('clears all services when given an empty array (edge — AC 12 empty-state)', async () => {
      await withProjectAndEndpoint(async ({ orgId, tx, projectId, userId, endpointId }) => {
        await enableStatusPage(tx, { orgId, projectId, userId })
        await updateStatusPageServices(tx, {
          orgId,
          projectId,
          body: { services: [{ serviceId: endpointId, displayName: 'Name' }] },
        })

        const result = await updateStatusPageServices(tx, {
          orgId,
          projectId,
          body: { services: [] },
        })
        expect(result.services).toEqual([])

        const config = await getStatusPageConfig(tx, projectId)
        expect(config.services).toEqual([])
      })
    })

    it('throws InvalidServiceReferenceError for a serviceId outside the project', async () => {
      await withProjectAndEndpoint(async ({ orgId, tx, projectId, userId }) => {
        await enableStatusPage(tx, { orgId, projectId, userId })
        await expect(
          updateStatusPageServices(tx, {
            orgId,
            projectId,
            body: { services: [{ serviceId: crypto.randomUUID(), displayName: 'Ghost' }] },
          })
        ).rejects.toThrow(InvalidServiceReferenceError)
      })
    })

    it('throws StatusPageNotFoundError when no status page exists yet', async () => {
      await withProjectAndEndpoint(async ({ orgId, tx, projectId, endpointId }) => {
        await expect(
          updateStatusPageServices(tx, {
            orgId,
            projectId,
            body: { services: [{ serviceId: endpointId, displayName: 'Name' }] },
          })
        ).rejects.toThrow(StatusPageNotFoundError)
      })
    })

    it('stores an HTML-shaped displayName verbatim without escaping (AC 15 injection example)', async () => {
      await withProjectAndEndpoint(async ({ orgId, tx, projectId, userId, endpointId }) => {
        await enableStatusPage(tx, { orgId, projectId, userId })
        const injected = '<script>alert(1)</script>'
        const result = await updateStatusPageServices(tx, {
          orgId,
          projectId,
          body: { services: [{ serviceId: endpointId, displayName: injected }] },
        })
        expect(result.services[0]?.displayName).toBe(injected)
      })
    })
  })

  describe('disableStatusPage (AC 16)', () => {
    it('hard-deletes the status page and returns a services snapshot for the audit payload (AC 17)', async () => {
      await withProjectAndEndpoint(async ({ orgId, tx, projectId, userId, endpointId }) => {
        await enableStatusPage(tx, { orgId, projectId, userId })
        await updateStatusPageServices(tx, {
          orgId,
          projectId,
          body: { services: [{ serviceId: endpointId, displayName: PAYMENTS_API_DISPLAY_NAME }] },
        })

        const result = await disableStatusPage(tx, projectId)
        expect(result?.snapshot).toEqual({ count: 1, displayNames: [PAYMENTS_API_DISPLAY_NAME] })
        expect(await findStatusPageByProject(tx, projectId)).toBeNull()
      })
    })

    it('returns null when no status page exists (caller maps this to 404, not idempotent-204)', async () => {
      await withProjectAndEndpoint(async ({ tx, projectId }) => {
        expect(await disableStatusPage(tx, projectId)).toBeNull()
      })
    })
  })
})
