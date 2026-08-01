import { describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import {
  externalIdentities,
  organizations,
  projectInvitations,
  users,
} from '@project-vault/db/schema'
import { bootstrapRouteIntegrationTest } from '../__tests__/helpers/auth-test-helpers.js'
import { initVaultForTest } from '../__tests__/helpers/auth-test-helpers.js'

const { initVault } = await bootstrapRouteIntegrationTest()

// Mocked so main()'s test never actually binds a real port — every other function under test
// here (ensureUnsealed, seedFixtures, printRunbook) exercises real DB/vault code, matching this
// repo's integration-test convention (docs/development.md); only the HTTP server itself is stubbed.
vi.mock('../app.js', () => ({
  createApp: vi.fn().mockResolvedValue({ listen: vi.fn().mockResolvedValue(undefined) }),
}))

const { seedFixtures, printRunbook, ensureUnsealed, main, PROVIDER_NAME } =
  await import('./sso-qa.js')
const { createApp } = await import('../app.js')

describe('sso-qa.ts (Story 14.3 Task 10, AC-12 manual-QA runbook)', () => {
  describe('printRunbook', () => {
    it('prints all three fixture scenarios with their expected outcomes and the given base URL', () => {
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

      printRunbook('http://127.0.0.1:3999')

      const output = writeSpy.mock.calls.map((call) => call[0]).join('')
      writeSpy.mockRestore()

      expect(output).toContain('http://127.0.0.1:3999')
      expect(output).toContain(`start/${PROVIDER_NAME}`)
      expect(output).toContain(`callback/${PROVIDER_NAME}`)
      expect(output).toContain('"credential":"linked-user"')
      expect(output).toContain('"credential":"unlinked-user"')
      expect(output).toContain('"credential":"invited-user"')
      expect(output).toContain('account_link_required')
    })
  })

  describe('ensureUnsealed', () => {
    it('is a no-op once the vault is already unsealed (repeated manual-QA runs)', async () => {
      await initVaultForTest(initVault, 'sso-qa-ensure-unsealed-test-passphrase')

      await expect(ensureUnsealed()).resolves.toBeUndefined()
    })
  })

  describe('seedFixtures', () => {
    it('seeds an org with a linked identity and a pending invitation for the invited-user fixture', async () => {
      const { orgId } = await seedFixtures()

      const [org] = await getDb().select().from(organizations).where(eq(organizations.id, orgId))
      expect(org).toBeDefined()

      const linkedIdentity = await withOrg(orgId, (tx) =>
        tx
          .select()
          .from(externalIdentities)
          .where(eq(externalIdentities.externalSubject, 'fixture-subject-linked-user'))
      )
      expect(linkedIdentity).toHaveLength(1)
      const identity = linkedIdentity[0]
      if (!identity) throw new Error('expected a linked external_identities row')
      expect(identity.providerName).toBe(PROVIDER_NAME)

      const [linkedUser] = await getDb().select().from(users).where(eq(users.id, identity.userId))
      expect(linkedUser?.email).toMatch(/^linked-user-[0-9a-f]+@example\.test$/)

      const invitation = await withOrg(orgId, (tx) =>
        tx
          .select()
          .from(projectInvitations)
          .where(eq(projectInvitations.email, 'invited-user@example.test'))
      )
      expect(invitation).toHaveLength(1)
      expect(invitation[0]?.acceptedAt).toBeNull()
      expect(invitation[0]?.roleToAssign).toBe('member')
    })
  })

  describe('main', () => {
    it('wires ensureUnsealed -> seedFixtures -> createApp -> listen -> printRunbook in order', async () => {
      process.env['SSO_QA_PORT'] = '3999'
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

      await main()

      writeSpy.mockRestore()
      expect(createApp).toHaveBeenCalledWith({ logger: true })
      const appInstance = await vi.mocked(createApp).mock.results[0]?.value
      expect(appInstance.listen).toHaveBeenCalledWith({ port: 3999, host: '127.0.0.1' })
    })
  })
})
