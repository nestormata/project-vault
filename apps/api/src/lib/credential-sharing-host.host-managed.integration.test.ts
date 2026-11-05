import { randomUUID } from 'node:crypto'
import pino from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { apiKeys, auditLogEntries, credentialShares, machineUsers } from '@project-vault/db/schema'
import type { CredentialSharingHost, ExtensionManifest } from '@project-vault/extension-api'
import {
  CredentialSharingNoMachineUserError,
  CredentialSharingRateLimitedError,
  CredentialSharingStepUpRequiredError,
  EXTENSION_API_VERSION,
} from '@project-vault/extension-api'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
} from '../__tests__/helpers/auth-test-helpers.js'
import { createLogCaptureStream, parseCapturedLogLines } from '../__tests__/helpers/capture-logs.js'
import {
  enrollTotpForSession,
  wrongCodeFor,
} from '../__tests__/helpers/external-share-step-up-test-helpers.js'
import { createMembershipTestHelpers } from '../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../__tests__/helpers/vault-test-cleanup.js'
import {
  bootCredentialRouteApp,
  createCredentialTestProject,
  createCredentialViaApi,
} from '../modules/credentials/credential-route-test-helpers.js'
import {
  buildCredentialSharingHost,
  __resetCredentialSharingHostRateLimitForTests,
  __resetCredentialSharingOrgRateLimitForTests,
} from './credential-sharing-host.js'
import { runWithRequestContext } from './request-context.js'

/**
 * Story 73.9 AC-1..AC-5 — real-Postgres proof (RLS on, the app role) of the host-managed machine
 * user: idempotent keyless provisioning, the lazy path on the 3.39.0 contract, the resolution order,
 * attribution (`shared_by` = acting user, `keyId: null`) and tenancy.
 */

const { createApp, initVault } = await bootstrapRouteIntegrationTest()
type TestApp = Awaited<ReturnType<typeof createApp>>

const { registerOwner, addUserToOrg, addProjectMember } = createMembershipTestHelpers({
  emailPrefix: 'cred-sharing-host-managed',
  orgNamePrefix: 'Credential Sharing Host Managed Org',
})

const EXTENSION_NAME = 'com.centralizeme.module-pack'
const CURRENT: ExtensionManifest = {
  name: EXTENSION_NAME,
  apiVersion: EXTENSION_API_VERSION,
  capabilities: [],
}
const LEGACY: ExtensionManifest = { ...CURRENT, apiVersion: '3.38.0' }
const MACHINE_USER_CREATED = 'machine_user.created'
const SHARE_CREATED = 'credential.share_created'

type Org = {
  orgId: string
  projectId: string
  credentialId: string
  owner: Awaited<ReturnType<typeof registerOwner>>
}

describe('host-managed credential-sharing machine user — real Postgres (Story 73.9)', () => {
  let app: TestApp
  const logCapture = createLogCaptureStream()
  const logger = pino({ level: 'debug' }, logCapture.stream)

  beforeAll(async () => {
    await resetVaultForTest()
    app = await bootCredentialRouteApp(createApp, initVault, 'credential-sharing-host-managed')
  })

  beforeEach(() => {
    __resetCredentialSharingHostRateLimitForTests()
    __resetCredentialSharingOrgRateLimitForTests()
    logCapture.lines.length = 0
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  async function newOrg(label: string): Promise<Org> {
    const owner = await registerOwner(app, label)
    const projectId = await createCredentialTestProject(app, owner.cookies, label)
    const credentialId = (
      await createCredentialViaApi(app, owner.cookies, projectId, {
        name: `host-managed-${randomUUID()}`,
        value: 'host-managed-secret',
      })
    ).id
    return { orgId: owner.orgId, projectId, credentialId, owner }
  }

  async function enrolledMember(org: Org) {
    const user = await addUserToOrg(app, org.orgId, 'member', { orgRole: 'member' })
    await addProjectMember(org.orgId, org.projectId, user.userId, 'member')
    const totp = await enrollTotpForSession(app, user.userId, user.cookies)
    return { userId: user.userId, totp }
  }

  async function addAdminKeyedMachineUser(org: Org): Promise<{ id: string; keyId: string }> {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${org.projectId}/machine-users`,
      headers: { cookie: cookieHeader(org.owner.cookies) },
      payload: { name: EXTENSION_NAME, role: 'member' },
    })
    expect(created.statusCode).toBe(201)
    const id = created.json<{ data: { id: string } }>().data.id
    const key = await app.inject({
      method: 'POST',
      url: `/api/v1/machine-users/${id}/api-keys`,
      headers: { cookie: cookieHeader(org.owner.cookies) },
      payload: { name: 'admin-keyed' },
    })
    expect(key.statusCode).toBe(201)
    return { id, keyId: key.json<{ data: { id: string } }>().data.id }
  }

  function hostManagedRows(orgId: string) {
    return withOrg(orgId, (tx) =>
      tx
        .select()
        .from(machineUsers)
        .where(and(eq(machineUsers.orgId, orgId), eq(machineUsers.hostManaged, true)))
    )
  }

  function auditRows(orgId: string, eventType: string) {
    return withOrg(orgId, (tx) =>
      tx
        .select({ actorType: auditLogEntries.actorType, payload: auditLogEntries.payload })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, eventType))
    )
  }

  function createAs(
    host: CredentialSharingHost,
    org: Org,
    acting: { userId: string; code: string },
    credentialId = org.credentialId
  ) {
    return runWithRequestContext({ orgId: org.orgId, userId: acting.userId }, () =>
      host.createExternalShare({
        organizationId: org.orgId,
        projectId: org.projectId,
        credentialId,
        recipientEmail: 'recipient@invalid',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        fieldKey: 'value',
        totpCode: acting.code,
      })
    )
  }

  describe('AC-1 provisionMachineUser', () => {
    it('creates one keyless, org-scoped, non-human row and one extension audit row', async () => {
      const org = await newOrg('provision')
      const result = await buildCredentialSharingHost(CURRENT, logger).provisionMachineUser({
        organizationId: org.orgId,
      })

      expect(Object.keys(result).sort()).toEqual(['created', 'machineUserId'])
      expect(result.created).toBe(true)
      const rows = await hostManagedRows(org.orgId)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        id: result.machineUserId,
        orgId: org.orgId,
        projectId: null,
        name: EXTENSION_NAME,
        role: 'viewer',
        createdBy: null,
        hostManaged: true,
        deactivatedAt: null,
      })
      const keys = await withOrg(org.orgId, (tx) =>
        tx.select().from(apiKeys).where(eq(apiKeys.machineUserId, result.machineUserId))
      )
      expect(keys).toEqual([])
      expect(await auditRows(org.orgId, MACHINE_USER_CREATED)).toEqual([
        {
          actorType: 'extension',
          payload: {
            extensionName: EXTENSION_NAME,
            machineUserId: result.machineUserId,
            hostManaged: true,
            trigger: 'provision',
          },
        },
      ])
      const provisionedLog = parseCapturedLogLines(logCapture.lines).find(
        (entry) => entry.eventType === 'credential_sharing_host.machine_user_provisioned'
      )
      expect(provisionedLog).toMatchObject({
        level: 30,
        extensionName: EXTENSION_NAME,
        organizationId: org.orgId,
        machineUserId: result.machineUserId,
        trigger: 'provision',
      })
    })

    it('is idempotent: a second call returns the same id with created false and writes nothing', async () => {
      const org = await newOrg('idempotent')
      const host = buildCredentialSharingHost(CURRENT, logger)
      const first = await host.provisionMachineUser({ organizationId: org.orgId })
      const second = await host.provisionMachineUser({ organizationId: org.orgId })
      expect(second).toEqual({ machineUserId: first.machineUserId, created: false })
      expect(await hostManagedRows(org.orgId)).toHaveLength(1)
      expect(await auditRows(org.orgId, MACHINE_USER_CREATED)).toHaveLength(1)
    })

    it('two concurrent first calls create exactly one row and one audit row', async () => {
      const org = await newOrg('concurrent')
      const results = await Promise.all([
        buildCredentialSharingHost(CURRENT, logger).provisionMachineUser({
          organizationId: org.orgId,
        }),
        buildCredentialSharingHost(CURRENT, logger).provisionMachineUser({
          organizationId: org.orgId,
        }),
      ])
      expect(new Set(results.map((r) => r.machineUserId)).size).toBe(1)
      expect(results.map((r) => r.created).sort()).toEqual([false, true])
      expect(await hostManagedRows(org.orgId)).toHaveLength(1)
      expect(await auditRows(org.orgId, MACHINE_USER_CREATED)).toHaveLength(1)
    })

    it('still creates the host-managed row when an admin-provisioned keyed row exists', async () => {
      const org = await newOrg('beside-admin')
      const admin = await addAdminKeyedMachineUser(org)
      const result = await buildCredentialSharingHost(CURRENT, logger).provisionMachineUser({
        organizationId: org.orgId,
      })
      expect(result.created).toBe(true)
      expect(result.machineUserId).not.toBe(admin.id)
    })

    it('never resurrects a deactivated host-managed row', async () => {
      const org = await newOrg('deactivated')
      const host = buildCredentialSharingHost(CURRENT, logger)
      const { machineUserId } = await host.provisionMachineUser({ organizationId: org.orgId })
      await withOrg(org.orgId, (tx) =>
        tx
          .update(machineUsers)
          .set({ deactivatedAt: new Date() })
          .where(eq(machineUsers.id, machineUserId))
      )
      await expect(host.provisionMachineUser({ organizationId: org.orgId })).rejects.toEqual(
        new CredentialSharingNoMachineUserError('provisionMachineUser')
      )
      expect(await hostManagedRows(org.orgId)).toHaveLength(1)
    })

    it.each([
      ['an unknown organization id', () => randomUUID()],
      ['a non-UUID organization id', () => 'not-an-org'],
    ])('fails closed for %s, with no row and no raw database error', async (_label, orgIdFor) => {
      const organizationId = orgIdFor()
      await expect(
        buildCredentialSharingHost(CURRENT, logger).provisionMachineUser({ organizationId })
      ).rejects.toEqual(new CredentialSharingNoMachineUserError('provisionMachineUser'))
      expect(logCapture.lines.join('')).toContain('credential_sharing_host.no_machine_user')
    })

    it('fails closed for a manifest name longer than a machine-user name may be', async () => {
      const org = await newOrg('long-name')
      const longName = `com.${'a'.repeat(125)}`
      expect(longName).toHaveLength(129)
      const host = buildCredentialSharingHost({ ...CURRENT, name: longName }, logger)
      await expect(host.provisionMachineUser({ organizationId: org.orgId })).rejects.toEqual(
        new CredentialSharingNoMachineUserError('provisionMachineUser')
      )
      expect(await hostManagedRows(org.orgId)).toEqual([])
    })

    it('goes through the per-extension in-flight cap', async () => {
      const org = await newOrg('capped')
      const host = buildCredentialSharingHost(CURRENT, logger, { maxInFlight: 0 })
      await expect(host.provisionMachineUser({ organizationId: org.orgId })).rejects.toBeInstanceOf(
        CredentialSharingRateLimitedError
      )
      expect(await hostManagedRows(org.orgId)).toEqual([])
    })
  })

  describe('AC-2/AC-3 lazy resolution and attribution', () => {
    it('on 3.39.0 a create with no admin row provisions lazily and attributes to the acting user', async () => {
      const org = await newOrg('lazy-create')
      const acting = await enrolledMember(org)
      const result = await createAs(buildCredentialSharingHost(CURRENT, logger), org, {
        userId: acting.userId,
        code: acting.totp.freshCode,
      })
      if (result.status !== 'ok') throw new Error(`create failed: ${result.status}`)
      expect(result.share.sharedBy).toBe(acting.userId)

      const [hostManaged] = await hostManagedRows(org.orgId)
      const [shareRow] = await withOrg(org.orgId, (tx) =>
        tx.select().from(credentialShares).where(eq(credentialShares.id, result.share.id))
      )
      expect(shareRow).toMatchObject({ sharedBy: acting.userId, hostCreated: true })
      const [shareAudit] = await auditRows(org.orgId, SHARE_CREATED)
      expect(shareAudit?.actorType).toBe('machine_user')
      expect(shareAudit?.payload).toMatchObject({ machineUserId: hostManaged?.id, keyId: null })
      expect(shareAudit?.payload).toHaveProperty('keyId', null)
      expect(await auditRows(org.orgId, MACHINE_USER_CREATED)).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ trigger: 'lazy:createExternalShare' }),
        }),
      ])
    })

    it('an admin-provisioned keyed row wins: its key and creator attribute the share', async () => {
      const org = await newOrg('admin-wins')
      const admin = await addAdminKeyedMachineUser(org)
      const acting = await enrolledMember(org)
      const result = await createAs(buildCredentialSharingHost(CURRENT, logger), org, {
        userId: acting.userId,
        code: acting.totp.freshCode,
      })
      if (result.status !== 'ok') throw new Error(`create failed: ${result.status}`)
      const [shareRow] = await withOrg(org.orgId, (tx) =>
        tx.select().from(credentialShares).where(eq(credentialShares.id, result.share.id))
      )
      expect(shareRow?.sharedBy).toBe(org.owner.userId)
      const [shareAudit] = await auditRows(org.orgId, SHARE_CREATED)
      expect(shareAudit?.payload).toMatchObject({ machineUserId: admin.id, keyId: admin.keyId })
      expect(await hostManagedRows(org.orgId)).toEqual([])
    })

    it.each([
      ['3.38.0', LEGACY],
      ['an unparsable version', { ...CURRENT, apiVersion: 'not-a-version' }],
    ])('%s fails closed and ignores an existing host-managed row', async (_label, manifest) => {
      const org = await newOrg('legacy')
      await buildCredentialSharingHost(CURRENT, logger).provisionMachineUser({
        organizationId: org.orgId,
      })
      const host = buildCredentialSharingHost(manifest, logger)
      await expect(
        createAs(host, org, { userId: org.owner.userId, code: '000000' })
      ).rejects.toBeInstanceOf(CredentialSharingNoMachineUserError)
      await expect(
        host.revokeShare({
          organizationId: org.orgId,
          projectId: org.projectId,
          credentialId: org.credentialId,
          shareId: randomUUID(),
        })
      ).rejects.toBeInstanceOf(CredentialSharingNoMachineUserError)
      await expect(
        host.supersedeSharesForRotation({
          organizationId: org.orgId,
          credentialId: org.credentialId,
          targetFields: null,
          rotationId: randomUUID(),
        })
      ).rejects.toBeInstanceOf(CredentialSharingNoMachineUserError)
    })

    it('a non-ok share result keeps the lazily created machine user and its audit row', async () => {
      const org = await newOrg('lazy-non-ok')
      const acting = await enrolledMember(org)
      const result = await createAs(
        buildCredentialSharingHost(CURRENT, logger),
        org,
        { userId: acting.userId, code: acting.totp.freshCode },
        randomUUID()
      )
      expect(result.status).not.toBe('ok')
      expect(await hostManagedRows(org.orgId)).toHaveLength(1)
      expect(await auditRows(org.orgId, MACHINE_USER_CREATED)).toHaveLength(1)
    })

    it('a thrown step-up refusal rolls the lazily created machine user back', async () => {
      const org = await newOrg('lazy-rollback')
      const acting = await enrolledMember(org)
      await expect(
        createAs(buildCredentialSharingHost(CURRENT, logger), org, {
          userId: acting.userId,
          code: wrongCodeFor(acting.totp.secret),
        })
      ).rejects.toBeInstanceOf(CredentialSharingStepUpRequiredError)
      expect(await hostManagedRows(org.orgId)).toEqual([])
      expect(await auditRows(org.orgId, MACHINE_USER_CREATED)).toEqual([])
    })

    it('revoke and supersede provision lazily and audit the host-managed id with keyId null', async () => {
      const org = await newOrg('lazy-revoke')
      const host = buildCredentialSharingHost(CURRENT, logger)
      const missing = await host.revokeShare({
        organizationId: org.orgId,
        projectId: org.projectId,
        credentialId: org.credentialId,
        shareId: randomUUID(),
      })
      expect(missing).toEqual({ status: 'not_found' })
      const [hostManaged] = await hostManagedRows(org.orgId)
      expect(await auditRows(org.orgId, MACHINE_USER_CREATED)).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ trigger: 'lazy:revokeShare' }),
        }),
      ])

      const first = await enrolledMember(org)
      const toRevoke = await createAs(host, org, {
        userId: first.userId,
        code: first.totp.freshCode,
      })
      if (toRevoke.status !== 'ok') throw new Error(`create failed: ${toRevoke.status}`)
      const revoked = await host.revokeShare({
        organizationId: org.orgId,
        projectId: org.projectId,
        credentialId: org.credentialId,
        shareId: toRevoke.share.id,
      })
      expect(revoked).toMatchObject({ status: 'ok', alreadyTerminal: false })
      const [revokeAudit] = await auditRows(org.orgId, 'credential.share_revoked')
      expect(revokeAudit?.payload).toMatchObject({ machineUserId: hostManaged?.id, keyId: null })

      const second = await enrolledMember(org)
      await createAs(host, org, { userId: second.userId, code: second.totp.freshCode })
      const superseded = await host.supersedeSharesForRotation({
        organizationId: org.orgId,
        credentialId: org.credentialId,
        targetFields: null,
        rotationId: randomUUID(),
      })
      expect(superseded.supersededShares).toHaveLength(1)
      const [supersedeAudit] = await auditRows(org.orgId, 'credential.share_superseded')
      expect(supersedeAudit?.payload).toMatchObject({ machineUserId: hostManaged?.id, keyId: null })
      expect(await hostManagedRows(org.orgId)).toHaveLength(1)
    })

    it('supersede on an empty org provisions lazily with its own trigger', async () => {
      const org = await newOrg('lazy-supersede')
      const result = await buildCredentialSharingHost(CURRENT, logger).supersedeSharesForRotation({
        organizationId: org.orgId,
        credentialId: org.credentialId,
        targetFields: null,
        rotationId: randomUUID(),
      })
      expect(result).toEqual({ supersededShares: [] })
      expect(await auditRows(org.orgId, MACHINE_USER_CREATED)).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ trigger: 'lazy:supersedeSharesForRotation' }),
        }),
      ])
    })
  })

  describe('AC-5 tenancy', () => {
    it('org B never sees or lends org A its principal, in provisioning, resolution or attribution', async () => {
      const orgA = await newOrg('tenant-a')
      const orgB = await newOrg('tenant-b')
      const host = buildCredentialSharingHost(CURRENT, logger)
      const inB = await host.provisionMachineUser({ organizationId: orgB.orgId })
      const inA = await host.provisionMachineUser({ organizationId: orgA.orgId })
      expect(inA.created).toBe(true)
      expect(inA.machineUserId).not.toBe(inB.machineUserId)
      expect((await hostManagedRows(orgB.orgId)).map((row) => row.id)).toEqual([inB.machineUserId])
      expect((await hostManagedRows(orgA.orgId)).map((row) => row.id)).toEqual([inA.machineUserId])

      const acting = await enrolledMember(orgA)
      const result = await createAs(host, orgA, {
        userId: acting.userId,
        code: acting.totp.freshCode,
      })
      if (result.status !== 'ok') throw new Error(`create failed: ${result.status}`)
      const [shareAudit] = await auditRows(orgA.orgId, SHARE_CREATED)
      expect(shareAudit?.payload).toMatchObject({ machineUserId: inA.machineUserId })
      expect(await auditRows(orgB.orgId, SHARE_CREATED)).toEqual([])
    })
  })
})
