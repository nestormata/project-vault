import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import {
  auditLogEntries,
  mfaEnrollments,
  securityAlerts,
  users,
  webauthnCredentials,
} from '@project-vault/db/schema'
import { AuditEvent, SecurityAlertType } from '@project-vault/shared'
import {
  configureAuthIntegrationEnv,
  cookieHeader,
  initVaultForTest,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { enrollUserWithMfa } from '../../__tests__/helpers/mfa-enroll-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { decideSignCount } from './webauthn-policy.js'

configureAuthIntegrationEnv()
vi.setConfig({ testTimeout: 30_000 })

const OPTIONS_URL = '/api/v1/auth/mfa/webauthn/register/options'
const REGISTER_URL = '/api/v1/auth/mfa/webauthn/register'
const LIST_URL = '/api/v1/auth/mfa/webauthn/credentials'
const PASSWORD = 'correct-horse-battery-staple'
const TEST_PASSPHRASE = 'webauthn-register-passphrase'
const TEST_CHALLENGE = 'test-challenge'
const DESK_KEY_NAME = 'Desk YubiKey'

vi.mock('./webauthn-lib.js', () => {
  const challenge = 'test-challenge'
  const userName = 'user@example.com'
  return {
    createRegistrationOptions: vi.fn(async () => ({
      challenge,
      options: {
        challenge,
        rp: { name: 'Project Vault', id: 'localhost' },
        user: { id: 'dXNlcg', name: userName, displayName: userName },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      },
    })),
    verifyAttestation: vi.fn(),
  }
})

const { verifyAttestation } = await import('./webauthn-lib.js')
const { reportClonedAuthenticator } = await import('./webauthn.js')

const { createApp } = await import('../../app.js')
const { initVault } = await import('../../modules/vault/key-service.js')

function fakeAttestation(id: string) {
  return {
    id,
    rawId: id,
    type: 'public-key' as const,
    response: {
      clientDataJSON: 'e30',
      attestationObject: 'e30',
    },
  }
}

describe('WebAuthn registration routes (Story 46.1)', () => {
  let app: Awaited<ReturnType<typeof createApp>>

  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
    app = await createApp({ logger: false })
  })

  afterAll(async () => {
    await app?.close()
    await resetVaultForTest()
  })

  beforeEach(() => {
    vi.mocked(verifyAttestation).mockReset()
  })

  it('returns 401 without a session', async () => {
    const options = await app.inject({ method: 'POST', url: OPTIONS_URL, payload: {} })
    const list = await app.inject({ method: 'GET', url: LIST_URL })
    expect(options.statusCode).toBe(401)
    expect(list.statusCode).toBe(401)
  })

  it('refuses options and register when TOTP is not enrolled and does not write mfa_enrolled_at', async () => {
    const registered = await registerAndLoginViaApi(app, {
      email: `webauthn-unenrolled-${randomUUID()}@example.com`,
      password: PASSWORD,
      orgName: `WebAuthn Unenrolled ${randomUUID()}`,
    })
    const cookies = cookieHeader(registered.cookies)
    const [before] = await getDb()
      .select({ mfaEnrolledAt: users.mfaEnrolledAt })
      .from(users)
      .where(eq(users.id, registered.userId))

    const options = await app.inject({
      method: 'POST',
      url: OPTIONS_URL,
      headers: { cookie: cookies },
      payload: {},
    })
    expect(options.statusCode).toBe(403)
    expect(options.json()).toMatchObject({ code: 'webauthn_requires_totp' })

    const register = await app.inject({
      method: 'POST',
      url: REGISTER_URL,
      headers: { cookie: cookies },
      payload: {
        challengeId: randomUUID(),
        name: 'Desk',
        attestation: fakeAttestation('abc'),
      },
    })
    expect(register.statusCode).toBe(403)
    expect(register.json()).toMatchObject({ code: 'webauthn_requires_totp' })

    const [after] = await getDb()
      .select({ mfaEnrolledAt: users.mfaEnrolledAt })
      .from(users)
      .where(eq(users.id, registered.userId))
    expect(after?.mfaEnrolledAt ?? null).toEqual(before?.mfaEnrolledAt ?? null)
  })

  it('registers, lists without public key, renames, and deletes a second key while TOTP remains', async () => {
    const enrolled = await enrollUserWithMfa(app, {
      emailPrefix: 'webauthn-happy',
      orgNamePrefix: 'WebAuthn Happy',
      password: PASSWORD,
    })
    const cookies = cookieHeader(enrolled.cookies)
    const [enrolledAtBefore] = await getDb()
      .select({ mfaEnrolledAt: users.mfaEnrolledAt })
      .from(users)
      .where(eq(users.id, enrolled.userId))

    const options = await app.inject({
      method: 'POST',
      url: OPTIONS_URL,
      headers: { cookie: cookies },
      payload: {},
    })
    expect(options.statusCode).toBe(200)
    const challengeId = options.json<{ data: { challengeId: string; options: unknown } }>().data
      .challengeId
    expect(
      options.json<{ data: { options: { challenge: string } } }>().data.options.challenge
    ).toBe(TEST_CHALLENGE)

    vi.mocked(verifyAttestation).mockResolvedValueOnce({
      verified: true,
      credentialId: `cred-desk-${randomUUID()}`,
      publicKey: new Uint8Array([1, 2, 3, 4]),
      signCount: 0,
      transports: ['usb'],
    })

    const register = await app.inject({
      method: 'POST',
      url: REGISTER_URL,
      headers: { cookie: cookies },
      payload: {
        challengeId,
        name: DESK_KEY_NAME,
        attestation: fakeAttestation('att-desk'),
        privateKey: 'should-be-ignored',
      },
    })
    expect(register.statusCode).toBe(200)
    const desk = register.json<{ data: { id: string; name: string } }>().data
    expect(desk.name).toBe(DESK_KEY_NAME)

    const list = await app.inject({ method: 'GET', url: LIST_URL, headers: { cookie: cookies } })
    expect(list.statusCode).toBe(200)
    const listed = list.json<{
      data: { credentials: Array<Record<string, unknown>> }
    }>().data.credentials
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ id: desk.id, name: DESK_KEY_NAME, signCount: 0 })
    expect(listed[0]).not.toHaveProperty('publicKey')
    expect(JSON.stringify(listed)).not.toMatch(/private/i)

    const options2 = await app.inject({
      method: 'POST',
      url: OPTIONS_URL,
      headers: { cookie: cookies },
      payload: {},
    })
    vi.mocked(verifyAttestation).mockResolvedValueOnce({
      verified: true,
      credentialId: `cred-travel-${randomUUID()}`,
      publicKey: new Uint8Array([9, 8, 7]),
      signCount: 0,
    })
    const travel = await app.inject({
      method: 'POST',
      url: REGISTER_URL,
      headers: { cookie: cookies },
      payload: {
        challengeId: options2.json<{ data: { challengeId: string } }>().data.challengeId,
        name: 'Travel',
        attestation: fakeAttestation('att-travel'),
      },
    })
    expect(travel.statusCode).toBe(200)
    const travelId = travel.json<{ data: { id: string } }>().data.id

    const renamed = await app.inject({
      method: 'PATCH',
      url: `${LIST_URL}/${desk.id}`,
      headers: { cookie: cookies },
      payload: { name: 'Office' },
    })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json()).toMatchObject({ data: { id: desk.id, name: 'Office' } })

    const deleted = await app.inject({
      method: 'DELETE',
      url: `${LIST_URL}/${travelId}`,
      headers: { cookie: cookies },
    })
    expect(deleted.statusCode).toBe(200)

    const afterList = await app.inject({
      method: 'GET',
      url: LIST_URL,
      headers: { cookie: cookies },
    })
    const remaining = afterList.json<{ data: { credentials: Array<{ name: string }> } }>().data
      .credentials
    expect(remaining.map((row) => row.name)).toEqual(['Office'])

    const [enrolledAtAfter] = await getDb()
      .select({ mfaEnrolledAt: users.mfaEnrolledAt })
      .from(users)
      .where(eq(users.id, enrolled.userId))
    expect(enrolledAtAfter?.mfaEnrolledAt?.toISOString()).toBe(
      enrolledAtBefore?.mfaEnrolledAt?.toISOString()
    )

    const stored = await getDb()
      .select({ publicKey: webauthnCredentials.publicKey })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.id, desk.id))
    expect(stored[0]?.publicKey).toBe(Buffer.from([1, 2, 3, 4]).toString('base64url'))
  })

  it('returns 409 when the same credential id is registered twice', async () => {
    const enrolled = await enrollUserWithMfa(app, {
      emailPrefix: 'webauthn-dup',
      orgNamePrefix: 'WebAuthn Dup',
      password: PASSWORD,
    })
    const cookies = cookieHeader(enrolled.cookies)
    const credentialId = `dup-${randomUUID()}`

    async function registerOnce() {
      const options = await app.inject({
        method: 'POST',
        url: OPTIONS_URL,
        headers: { cookie: cookies },
        payload: {},
      })
      vi.mocked(verifyAttestation).mockResolvedValueOnce({
        verified: true,
        credentialId,
        publicKey: new Uint8Array([1]),
        signCount: 0,
      })
      return app.inject({
        method: 'POST',
        url: REGISTER_URL,
        headers: { cookie: cookies },
        payload: {
          challengeId: options.json<{ data: { challengeId: string } }>().data.challengeId,
          name: 'Key',
          attestation: fakeAttestation('att'),
        },
      })
    }

    expect((await registerOnce()).statusCode).toBe(200)
    const second = await registerOnce()
    expect(second.statusCode, JSON.stringify(second.json())).toBe(409)
    expect(second.json()).toMatchObject({ code: 'webauthn_credential_exists' })
  })

  it('rejects a replayed challenge', async () => {
    const enrolled = await enrollUserWithMfa(app, {
      emailPrefix: 'webauthn-replay',
      orgNamePrefix: 'WebAuthn Replay',
      password: PASSWORD,
    })
    const cookies = cookieHeader(enrolled.cookies)
    const options = await app.inject({
      method: 'POST',
      url: OPTIONS_URL,
      headers: { cookie: cookies },
      payload: {},
    })
    const challengeId = options.json<{ data: { challengeId: string } }>().data.challengeId
    vi.mocked(verifyAttestation).mockResolvedValue({
      verified: true,
      credentialId: `replay-${randomUUID()}`,
      publicKey: new Uint8Array([1]),
      signCount: 0,
    })
    const first = await app.inject({
      method: 'POST',
      url: REGISTER_URL,
      headers: { cookie: cookies },
      payload: {
        challengeId,
        name: 'Desk',
        attestation: fakeAttestation('att'),
      },
    })
    expect(first.statusCode).toBe(200)
    const replay = await app.inject({
      method: 'POST',
      url: REGISTER_URL,
      headers: { cookie: cookies },
      payload: {
        challengeId,
        name: 'Desk 2',
        attestation: fakeAttestation('att2'),
      },
    })
    expect(replay.statusCode).toBe(422)
    expect(replay.json()).toMatchObject({ code: 'webauthn_challenge_expired' })
  })

  it('returns 404 when renaming another user credential', async () => {
    const ownerA = await enrollUserWithMfa(app, {
      emailPrefix: 'webauthn-a',
      orgNamePrefix: 'WebAuthn A',
      password: PASSWORD,
    })
    const ownerB = await enrollUserWithMfa(app, {
      emailPrefix: 'webauthn-b',
      orgNamePrefix: 'WebAuthn B',
      password: PASSWORD,
    })
    const options = await app.inject({
      method: 'POST',
      url: OPTIONS_URL,
      headers: { cookie: cookieHeader(ownerA.cookies) },
      payload: {},
    })
    vi.mocked(verifyAttestation).mockResolvedValueOnce({
      verified: true,
      credentialId: `other-${randomUUID()}`,
      publicKey: new Uint8Array([1]),
      signCount: 0,
    })
    const created = await app.inject({
      method: 'POST',
      url: REGISTER_URL,
      headers: { cookie: cookieHeader(ownerA.cookies) },
      payload: {
        challengeId: options.json<{ data: { challengeId: string } }>().data.challengeId,
        name: 'A key',
        attestation: fakeAttestation('att'),
      },
    })
    const id = created.json<{ data: { id: string } }>().data.id
    const rename = await app.inject({
      method: 'PATCH',
      url: `${LIST_URL}/${id}`,
      headers: { cookie: cookieHeader(ownerB.cookies) },
      payload: { name: 'Stolen' },
    })
    expect(rename.statusCode).toBe(404)
  })

  it('refuses deleting the last remaining second factor for an owner', async () => {
    const enrolled = await enrollUserWithMfa(app, {
      emailPrefix: 'webauthn-last',
      orgNamePrefix: 'WebAuthn Last',
      password: PASSWORD,
    })
    const [inserted] = await getDb()
      .insert(webauthnCredentials)
      .values({
        userId: enrolled.userId,
        credentialId: `only-${randomUUID()}`,
        publicKey: 'AQID',
        signCount: 0,
        name: 'Only key',
      })
      .returning({ id: webauthnCredentials.id })
    await getDb()
      .delete(mfaEnrollments)
      .where(
        and(eq(mfaEnrollments.userId, enrolled.userId), eq(mfaEnrollments.status, 'confirmed'))
      )
    const response = await app.inject({
      method: 'DELETE',
      url: `${LIST_URL}/${inserted?.id}`,
      headers: { cookie: cookieHeader(enrolled.cookies) },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ code: 'last_second_factor_required' })
    expect(String(response.json<{ message: string }>().message)).toMatch(/Owner and Admin MFA/)
  })

  it('writes a cloned-authenticator security alert and never accepts the regression', async () => {
    const enrolled = await enrollUserWithMfa(app, {
      emailPrefix: 'webauthn-clone',
      orgNamePrefix: 'WebAuthn Clone',
      password: PASSWORD,
    })
    expect(decideSignCount(5, 3)).toEqual({ kind: 'cloned' })
    const [row] = await getDb()
      .insert(webauthnCredentials)
      .values({
        userId: enrolled.userId,
        credentialId: `clone-${randomUUID()}`,
        publicKey: 'AQID',
        signCount: 5,
        name: 'Cloned',
      })
      .returning({ id: webauthnCredentials.id })
    if (!row) throw new Error('expected credential row')

    await withOrg(enrolled.orgId, (tx) =>
      reportClonedAuthenticator(tx, {
        orgId: enrolled.orgId,
        userId: enrolled.userId,
        credentialRowId: row.id,
        storedCounter: 5,
        observedCounter: 3,
      })
    )

    const alerts = await withOrg(enrolled.orgId, (tx) =>
      tx
        .select({
          alertType: securityAlerts.alertType,
          severity: securityAlerts.severity,
          payload: securityAlerts.payload,
          orgId: securityAlerts.orgId,
        })
        .from(securityAlerts)
        .where(eq(securityAlerts.alertType, SecurityAlertType.WEBAUTHN_CLONED_AUTHENTICATOR))
    )
    const mine = alerts.filter((alert) => alert.orgId === enrolled.orgId)
    expect(mine.length).toBeGreaterThan(0)
    expect(mine[0]).toMatchObject({
      severity: 'critical',
      payload: { credentialId: row.id, storedCounter: 5, observedCounter: 3 },
    })
    expect(JSON.stringify(mine[0]?.payload)).not.toMatch(/publicKey|private/i)

    const audits = await withOrg(enrolled.orgId, (tx) =>
      tx
        .select({ eventType: auditLogEntries.eventType })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, AuditEvent.WEBAUTHN_CLONED_AUTHENTICATOR))
    )
    expect(audits.length).toBeGreaterThan(0)

    const [stored] = await getDb()
      .select({ signCount: webauthnCredentials.signCount })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.id, row.id))
    expect(stored?.signCount).toBe(5)
  })
})
