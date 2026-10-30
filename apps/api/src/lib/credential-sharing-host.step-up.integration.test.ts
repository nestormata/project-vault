import { randomUUID } from 'node:crypto'
import pino from 'pino'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditLogEntries, credentialShares } from '@project-vault/db/schema'
import type {
  CredentialSharingCreateExternalShareParams,
  CredentialSharingHost,
  ExtensionManifest,
} from '@project-vault/extension-api'
import {
  CredentialSharingActingUserInvalidError,
  CredentialSharingActingUserMismatchError,
  CredentialSharingStepUpRequiredError,
  CredentialSharingTotpEnrollmentRequiredError,
  EXTENSION_API_VERSION,
} from '@project-vault/extension-api'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
} from '../__tests__/helpers/auth-test-helpers.js'
import { createLogCaptureStream } from '../__tests__/helpers/capture-logs.js'
import {
  enrollTotpForSession,
  startPendingTotpEnrollment,
  wrongCodeFor,
  type EnrolledTotp,
} from '../__tests__/helpers/external-share-step-up-test-helpers.js'
import {
  createMembershipTestHelpers,
  MEMBERSHIP_TEST_LOGIN_SECRET,
} from '../__tests__/helpers/membership-test-helpers.js'
import { totpForSecret } from '../__tests__/helpers/totp.js'
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
import { forEachSequential } from './for-each-sequential.js'
import { runWithRequestContext } from './request-context.js'

/**
 * Story 72.21 AC2-AC5 — real-Postgres proof (RLS on, the app role) that `createExternalShare`
 * re-checks the acting user's TOTP before it writes anything. Every refusal asserts that no
 * `credential_shares` row and no `credential.share_created` audit row was added.
 */

const { createApp, initVault } = await bootstrapRouteIntegrationTest()
type TestApp = Awaited<ReturnType<typeof createApp>>

const { registerOwner, addUserToOrg, addProjectMember } = createMembershipTestHelpers({
  emailPrefix: 'cred-sharing-step-up',
  orgNamePrefix: 'Credential Sharing Step Up Org',
})

const EXTENSION_NAME = 'com.acme.credential-sharing-step-up-fixture'
const CURRENT: ExtensionManifest = {
  name: EXTENSION_NAME,
  apiVersion: EXTENSION_API_VERSION,
  capabilities: [],
}
const LEGACY: ExtensionManifest = { ...CURRENT, apiVersion: '3.37.0' }
const SHARE_CREATED = 'credential.share_created'
const STEP_UP = CredentialSharingStepUpRequiredError
const ENROLLMENT = CredentialSharingTotpEnrollmentRequiredError

describe('createExternalShare step-up — real Postgres (Story 72.21)', () => {
  let app: TestApp
  let orgId: string
  let projectId: string
  let credentialId: string
  let owner: Awaited<ReturnType<typeof registerOwner>>
  let foreignUserId: string
  let stdout: ReturnType<typeof vi.spyOn>
  let stderr: ReturnType<typeof vi.spyOn>
  const written: string[] = []
  const logCapture = createLogCaptureStream()
  const logger = pino({ level: 'debug' }, logCapture.stream)

  beforeAll(async () => {
    await resetVaultForTest()
    app = await bootCredentialRouteApp(createApp, initVault, 'credential-sharing-step-up-pass')
    owner = await registerOwner(app, 'owner')
    orgId = owner.orgId
    projectId = await createCredentialTestProject(app, owner.cookies, 'step-up')
    foreignUserId = (await registerOwner(app, 'foreign')).userId

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/machine-users`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { name: EXTENSION_NAME, role: 'member' },
    })
    expect(created.statusCode).toBe(201)
    const key = await app.inject({
      method: 'POST',
      url: `/api/v1/machine-users/${created.json<{ data: { id: string } }>().data.id}/api-keys`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { name: 'step-up-fixture-key' },
    })
    expect(key.statusCode).toBe(201)
  })

  beforeEach(async () => {
    credentialId = (
      await createCredentialViaApi(app, owner.cookies, projectId, {
        name: `step-up-credential-${randomUUID()}`,
        value: 'step-up-secret',
      })
    ).id
    __resetCredentialSharingHostRateLimitForTests()
    __resetCredentialSharingOrgRateLimitForTests()
    written.length = 0
    logCapture.lines.length = 0
    const record = (chunk: unknown) => {
      written.push(String(chunk))
      return true
    }
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(record)
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(record)
  })

  afterEach(() => {
    stdout.mockRestore()
    stderr.mockRestore()
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  async function member(options: { enroll: boolean }) {
    const user = await addUserToOrg(app, orgId, 'member', { orgRole: 'member' })
    await addProjectMember(orgId, projectId, user.userId, 'member')
    const totp: EnrolledTotp | null = options.enroll
      ? await enrollTotpForSession(app, user.userId, user.cookies)
      : null
    return { ...user, totp }
  }

  function create(
    manifest: ExtensionManifest,
    extra: Record<string, unknown>,
    ambientUserId?: string
  ) {
    const host: CredentialSharingHost = buildCredentialSharingHost(manifest, logger)
    const params = {
      organizationId: orgId,
      projectId,
      credentialId,
      recipientEmail: 'recipient@invalid',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      fieldKey: 'value',
      ...extra,
    } as CredentialSharingCreateExternalShareParams
    const call = () => host.createExternalShare(params)
    return ambientUserId ? runWithRequestContext({ orgId, userId: ambientUserId }, call) : call()
  }

  async function rowCounts() {
    return withOrg(orgId, async (tx) => ({
      shares: (await tx.select({ id: credentialShares.id }).from(credentialShares)).length,
      audit: (
        await tx
          .select({ id: auditLogEntries.id })
          .from(auditLogEntries)
          .where(eq(auditLogEntries.eventType, SHARE_CREATED))
      ).length,
    }))
  }

  async function expectRefused(
    attempt: () => Promise<unknown>,
    errorClass: typeof STEP_UP | typeof ENROLLMENT | typeof CredentialSharingActingUserInvalidError
  ) {
    const before = await rowCounts()
    await expect(attempt()).rejects.toBeInstanceOf(errorClass)
    expect(await rowCounts()).toEqual(before)
  }

  function expectNoLogContains(secretText: string) {
    const everything = [...logCapture.lines, ...written].join('')
    expect(everything).not.toContain(secretText)
  }

  it('happy path: a current code creates the share and exactly one audit row', async () => {
    const user = await member({ enroll: true })
    const before = await rowCounts()
    const result = await create(CURRENT, { totpCode: user.totp?.freshCode }, user.userId)
    if (result.status !== 'ok') throw new Error(`create failed: ${result.status}`)
    expect(result.share.sharedBy).toBe(user.userId)
    expect(result.token.length).toBeGreaterThan(0)
    expect(await rowCounts()).toEqual({ shares: before.shares + 1, audit: before.audit + 1 })
    expectNoLogContains(user.totp?.freshCode ?? 'unset')
  })

  it('refuses a missing, empty or non-string code with the step-up error', async () => {
    const user = await member({ enroll: true })
    await forEachSequential([undefined, '', 123456, null, ['123456'], { code: '123456' }], (bad) =>
      expectRefused(() => create(CURRENT, { totpCode: bad }, user.userId), STEP_UP)
    )
  })

  it('refuses a valid code supplied only in an unknown field', async () => {
    const user = await member({ enroll: true })
    const code = user.totp?.freshCode
    await expectRefused(() => create(CURRENT, { password: code }, user.userId), STEP_UP)
    await expectRefused(() => create(CURRENT, { stepUp: code }, user.userId), STEP_UP)
    await expectRefused(() => create(CURRENT, { stepUp: { totpCode: code } }, user.userId), STEP_UP)
    const ok = await create(CURRENT, { totpCode: code }, user.userId)
    expect(ok.status).toBe('ok')
  })

  it('refuses a wrong code and never logs it', async () => {
    const user = await member({ enroll: true })
    const wrong = wrongCodeFor(user.totp?.secret ?? '')
    await expectRefused(() => create(CURRENT, { totpCode: wrong }, user.userId), STEP_UP)
    expectNoLogContains(wrong)
  })

  it('refuses a code already used by a share, and the enrollment code', async () => {
    const user = await member({ enroll: true })
    const used = user.totp?.freshCode
    expect((await create(CURRENT, { totpCode: used }, user.userId)).status).toBe('ok')
    await expectRefused(() => create(CURRENT, { totpCode: used }, user.userId), STEP_UP)
    await expectRefused(
      () => create(CURRENT, { totpCode: user.totp?.enrollmentCode }, user.userId),
      STEP_UP
    )
    expectNoLogContains(used ?? 'unset')
  })

  it('refuses a code already spent at login', async () => {
    const user = await member({ enroll: true })
    const code = user.totp?.freshCode ?? ''
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.email, password: MEMBERSHIP_TEST_LOGIN_SECRET },
    })
    const mfaToken = login.json<{ data: { mfaToken: string } }>().data.mfaToken
    const verified = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify-login',
      payload: { mfaToken, totp: code },
    })
    expect(verified.statusCode).toBe(200)
    await expectRefused(() => create(CURRENT, { totpCode: code }, user.userId), STEP_UP)
  })

  it('answers a user with no enrollment with the enrollment error, with or without a code', async () => {
    const user = await member({ enroll: false })
    await expectRefused(() => create(CURRENT, {}, user.userId), ENROLLMENT)
    await expectRefused(() => create(CURRENT, { totpCode: '123456' }, user.userId), ENROLLMENT)
    await expectRefused(() => create(CURRENT, { totpCode: '' }, user.userId), ENROLLMENT)
  })

  it('counts a pending, unconfirmed enrollment as none', async () => {
    const user = await member({ enroll: false })
    const secret = await startPendingTotpEnrollment(app, user.userId, user.cookies)
    const code = totpForSecret(secret)
    await expectRefused(() => create(CURRENT, { totpCode: code }, user.userId), ENROLLMENT)
    await expectRefused(() => create(CURRENT, {}, user.userId), ENROLLMENT)
  })

  it('refuses a create with no request user and no actingUserId', async () => {
    await expectRefused(() => create(CURRENT, { totpCode: '123456' }), STEP_UP)
    await expectRefused(() => create(CURRENT, {}), STEP_UP)
  })

  it('accepts an out-of-request create that names an enrolled acting user and his code', async () => {
    const user = await member({ enroll: true })
    const result = await create(CURRENT, {
      actingUserId: user.userId,
      totpCode: user.totp?.freshCode,
    })
    if (result.status !== 'ok') throw new Error(`create failed: ${result.status}`)
    expect(result.share.sharedBy).toBe(user.userId)
  })

  it('keeps an acting user of another org invalid, before the step-up runs', async () => {
    await expectRefused(
      () => create(CURRENT, { actingUserId: foreignUserId, totpCode: '123456' }),
      CredentialSharingActingUserInvalidError
    )
    const user = await member({ enroll: true })
    const before = await rowCounts()
    await expect(
      create(CURRENT, { actingUserId: foreignUserId, totpCode: user.totp?.freshCode }, user.userId)
    ).rejects.toBeInstanceOf(CredentialSharingActingUserMismatchError)
    expect(await rowCounts()).toEqual(before)
  })

  it('keeps the 3.37.0 behaviour for a manifest below the release: no code, no enrollment', async () => {
    const user = await member({ enroll: false })
    const before = await rowCounts()
    const result = await create(LEGACY, {}, user.userId)
    expect(result.status).toBe('ok')
    expect(await rowCounts()).toEqual({ shares: before.shares + 1, audit: before.audit + 1 })
    expect((await create(LEGACY, {})).status).toBe('ok')
  })

  it('gives an unparsable declared version the step-up (fail closed)', async () => {
    const user = await member({ enroll: true })
    await expectRefused(
      () => create({ ...CURRENT, apiVersion: 'not-a-version' }, {}, user.userId),
      STEP_UP
    )
  })

  it('lets exactly one of two parallel creates with the same code through', async () => {
    const user = await member({ enroll: true })
    const before = await rowCounts()
    const settled = await Promise.allSettled([
      create(CURRENT, { totpCode: user.totp?.freshCode }, user.userId),
      create(CURRENT, { totpCode: user.totp?.freshCode }, user.userId),
    ])
    const fulfilled = settled.filter((outcome) => outcome.status === 'fulfilled')
    const rejected = settled.filter((outcome) => outcome.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(STEP_UP)
    expect(await rowCounts()).toEqual({ shares: before.shares + 1, audit: before.audit + 1 })
  })

  it('does not echo a code in the error message', async () => {
    const user = await member({ enroll: true })
    const code = wrongCodeFor(user.totp?.secret ?? '')
    const error = await create(CURRENT, { totpCode: code }, user.userId).catch((e: unknown) => e)
    expect(String((error as Error).message)).not.toContain(code)
  })
})
