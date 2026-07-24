import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditLogEntries } from '@project-vault/db/schema'
import { withTestOrg } from '@project-vault/db/test-helpers'
import type { ExtensionHooks, ExtensionManifest } from '@project-vault/extension-api'
import { resetVaultForTest } from '../__tests__/helpers/vault-test-cleanup.js'
import { ensureWorkerTestEnv, unsealWorkerTestVault } from '../workers/worker-test-helpers.js'
import { __resetExtensionStateForTests, loadExtension } from './loader.js'

ensureWorkerTestEnv()

const { initVault } = await import('../modules/vault/key-service.js')

const TEST_PASSPHRASE = 'extension-loader-audit-passphrase'

const VALID_MANIFEST: ExtensionManifest = {
  name: 'com.acme.sso-extension',
  apiVersion: '^1.0.0',
  capabilities: ['auth-provider'],
}

function validImportFn() {
  return async () => ({
    default: { manifest: VALID_MANIFEST, hooksFactory: (): ExtensionHooks => ({}) },
  })
}

async function readAuditRows(orgId: string, eventType: string) {
  const rows = await withOrg(orgId, (tx) =>
    tx.select().from(auditLogEntries).where(eq(auditLogEntries.orgId, orgId))
  )
  return rows.filter((row) => row.eventType === eventType)
}

describe.sequential('loadExtension — audit write (Task 3, DB integration)', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    await unsealWorkerTestVault(initVault, TEST_PASSPHRASE)
  })

  afterAll(async () => {
    await resetVaultForTest()
  })

  beforeEach(() => {
    __resetExtensionStateForTests()
  })

  it('writes an extension.loaded row for the given org with the manifest payload shape', async () => {
    await withTestOrg(async ({ orgId }) => {
      await loadExtension('@acme/extension', {
        importFn: validImportFn(),
        listOrgIds: async () => [orgId],
      })

      const rows = await readAuditRows(orgId, 'extension.loaded')
      expect(rows).toHaveLength(1)
      const row = rows[0]
      expect(row?.actorType).toBe('system')
      expect(row?.actorTokenId).toBeNull()
      expect(row?.payload).toEqual({
        name: VALID_MANIFEST.name,
        apiVersion: VALID_MANIFEST.apiVersion,
        capabilities: VALID_MANIFEST.capabilities,
      })
    })
  })

  it('writes an extension.load_failed row with the fixed-enum reason, never the raw message', async () => {
    await withTestOrg(async ({ orgId }) => {
      await loadExtension('missing-package', {
        importFn: async () => {
          throw new Error('super secret internal path leaked here if not redacted')
        },
        listOrgIds: async () => [orgId],
      })

      const rows = await readAuditRows(orgId, 'extension.load_failed')
      expect(rows).toHaveLength(1)
      const row = rows[0]
      expect(row?.payload).toEqual({ reason: 'import_error' })
      expect(JSON.stringify(row?.payload)).not.toContain('super secret internal path')
    })
  })
})
