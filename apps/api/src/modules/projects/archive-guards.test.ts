import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { insertTestProject } from '@project-vault/db/test-helpers'
import { projects } from '@project-vault/db/schema'
import { eq } from 'drizzle-orm'
import {
  bootstrapRouteIntegrationTest,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { bootProjectRouteTestApp } from './project-route-test-bootstrap.js'
import {
  findBlockingRotationIds,
  hasActiveMachineUserKeys,
  isProjectArchived,
} from './archive-guards.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

describe('archive-guards', () => {
  let app: TestApp
  let orgId: string
  let userId: string

  beforeAll(async () => {
    app = await bootProjectRouteTestApp(createApp, initVault)
    const user = await registerAndLoginViaApi(app, {
      email: `archive-guards-${randomUUID()}@example.com`,
      password: 'correct-horse-battery-staple',
      orgName: `Archive Guards ${randomUUID()}`,
    })
    orgId = user.orgId
    userId = user.userId
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  describe('findBlockingRotationIds (ADR-4.4-02 table-existence seam)', () => {
    it('returns [] when the `rotations` table does not exist yet (Epic 5 not delivered)', async () => {
      const project = await insertTestProject(orgId, { userId, slug: 'rotation-guard' })

      const blockingIds = await withOrg(orgId, (tx) => findBlockingRotationIds(tx, project.id))

      expect(blockingIds).toEqual([])
    })

    it('CI guard (ADR-4.4-02): fails if `rotations` now exists but the seam is still present', async () => {
      // Once Story 5.1 ships the `rotations` table, this assertion starts failing on purpose —
      // that failure is the signal to replace findBlockingRotationIds's raw-SQL seam with a typed
      // Drizzle query and delete this test along with the seam (see archive-guards.ts).
      const [row] = await withOrg(orgId, (tx) =>
        tx.execute(sql`SELECT to_regclass('public.rotations') AS reg`)
      )
      const rotationsTableExists = (row as { reg: string | null } | undefined)?.reg !== null

      if (rotationsTableExists) {
        throw new Error(
          'The `rotations` table now exists (Story 5.1 shipped) but findBlockingRotationIds ' +
            '(apps/api/src/modules/projects/archive-guards.ts) still contains the ADR-4.4-02 ' +
            'table-existence seam. Replace it with a typed Drizzle query against the rotations ' +
            'schema and delete rotationsTableExists per the story dev notes.'
        )
      }
      expect(rotationsTableExists).toBe(false)
    })
  })

  describe('hasActiveMachineUserKeys (Epic 7 stub)', () => {
    it('always returns false until Epic 7 ships', async () => {
      const project = await insertTestProject(orgId, { userId, slug: 'machine-user-guard' })
      const result = await withOrg(orgId, (tx) => hasActiveMachineUserKeys(tx, project.id))
      expect(result).toBe(false)
    })
  })

  describe('isProjectArchived', () => {
    it('returns false for an active project and true once archived_at is set', async () => {
      const project = await insertTestProject(orgId, { userId, slug: 'archived-guard' })

      const beforeArchive = await withOrg(orgId, (tx) => isProjectArchived(tx, project.id))
      expect(beforeArchive).toBe(false)

      await withOrg(orgId, (tx) =>
        tx.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, project.id))
      )

      const afterArchive = await withOrg(orgId, (tx) => isProjectArchived(tx, project.id))
      expect(afterArchive).toBe(true)
    })

    it('returns false for a non-existent project id', async () => {
      const result = await withOrg(orgId, (tx) => isProjectArchived(tx, randomUUID()))
      expect(result).toBe(false)
    })
  })
})
