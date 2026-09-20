import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionManifest } from '@project-vault/extension-api'
import {
  CredentialSharingNoMachineUserError,
  CredentialSharingOrgRateLimitedError,
  CredentialSharingRateLimitedError,
} from '@project-vault/extension-api'

/**
 * Story 20.12 — unit coverage for `buildCredentialSharingHost`, mirroring
 * `monitoring-host.list-service-endpoints-for-scheduling.test.ts`'s own `withOrg`/service-layer-
 * mocking precedent so this facade's own control flow (thin-closure wiring, AC5 in-flight
 * rate-limiting/audit-logging, AC5b per-org rate-limiting, Design Decision A's fail-closed
 * machine-user resolution) is isolated from a live database. Real-Postgres cross-tenant/end-to-end
 * proof lives in `credential-sharing-host.integration.test.ts`.
 */

const { withOrg } = vi.hoisted(() => ({ withOrg: vi.fn() }))
vi.mock('@project-vault/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@project-vault/db')>()
  return { ...actual, withOrg }
})

const { revokeShare, supersedeOutstandingSharesForRotation } = vi.hoisted(() => ({
  revokeShare: vi.fn(),
  supersedeOutstandingSharesForRotation: vi.fn(),
}))
vi.mock('../modules/credential-shares/service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../modules/credential-shares/service.js')>()
  return { ...actual, revokeShare, supersedeOutstandingSharesForRotation }
})

const { createExternalCredentialShare, findExternalShareByTokenHash, revealExternalShare } =
  vi.hoisted(() => ({
    createExternalCredentialShare: vi.fn(),
    findExternalShareByTokenHash: vi.fn(),
    revealExternalShare: vi.fn(),
  }))
vi.mock('../modules/credential-shares/external-service.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../modules/credential-shares/external-service.js')>()
  return {
    ...actual,
    createExternalCredentialShare,
    findExternalShareByTokenHash,
    revealExternalShare,
  }
})

const { writeMachineAuditEntry } = vi.hoisted(() => ({ writeMachineAuditEntry: vi.fn() }))
vi.mock('../modules/audit/machine-entry.js', () => ({ writeMachineAuditEntry }))

const {
  buildCredentialSharingHost,
  __resetCredentialSharingHostRateLimitForTests,
  __resetCredentialSharingOrgRateLimitForTests,
  __getCredentialSharingHostInFlightCountForTests,
} = await import('./credential-sharing-host.js')

// Test-fixture UUIDs, not secrets.
/* eslint-disable no-secrets/no-secrets */
const ORG_ID = '11111111-1111-1111-1111-111111111111'
const PROJECT_ID = '22222222-2222-2222-2222-222222222222'
const CREDENTIAL_ID = '33333333-3333-3333-3333-333333333333'
const SHARE_ID = '44444444-4444-4444-4444-444444444444'
const MACHINE_USER_ID = '55555555-5555-5555-5555-555555555555'
const KEY_ID = '66666666-6666-6666-6666-666666666666'
const OTHER_ORG_ID = '77777777-7777-7777-7777-777777777777'
const CREATED_BY_USER_ID = '88888888-8888-8888-8888-888888888888'
/* eslint-enable no-secrets/no-secrets */
const VALID_TOKEN = 'valid-token'
const RECIPIENT_EMAIL = 'recipient@invalid'
const EXPIRES_AT_ISO = '2026-01-02T00:00:00.000Z'
const ROTATION_ID = 'rotation-1'

const MANIFEST: ExtensionManifest = {
  name: 'com.acme.credential-sharing-fixture',
  apiVersion: '3.22.0',
  capabilities: [],
}

const FAKE_TX: Record<string, unknown> = { __fakeTx: true }

const SHARE_ROW = {
  id: SHARE_ID,
  orgId: ORG_ID,
  credentialId: CREDENTIAL_ID,
  fieldKey: null,
  attributeKeys: null,
  action: 'read' as const,
  sharedBy: MACHINE_USER_ID,
  recipientType: 'external' as const,
  recipientUserId: null,
  recipientEmail: RECIPIENT_EMAIL,
  tokenHash: 'deadbeef',
  singleUse: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  expiresAt: new Date(EXPIRES_AT_ISO),
  revokedAt: null,
  supersededAt: null,
  firstViewedAt: null,
  viewCount: 0,
  status: 'active' as const,
  revealAttemptCount: 0,
}

/** Builds a fake drizzle-select chain resolving to `rows` at `.where()`, mirroring the
 * `machineUsers`-innerJoin-`apiKeys` query `resolveMachineUserForExtension` performs. */
function makeMachineUserSelectChain(rows: unknown[]) {
  return {
    from: () => ({
      innerJoin: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
  }
}

function liveMachineUserRow() {
  return {
    machineUserId: MACHINE_USER_ID,
    keyId: KEY_ID,
    createdBy: CREATED_BY_USER_ID,
    revokedAt: null,
    expiresAt: null,
    machineUserDeactivatedAt: null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  withOrg.mockImplementation(async (_orgId: string, fn: (tx: unknown) => unknown) => fn(FAKE_TX))
  FAKE_TX.select = vi.fn(() => makeMachineUserSelectChain([liveMachineUserRow()]))
  createExternalCredentialShare.mockResolvedValue({
    status: 'ok',
    share: SHARE_ROW,
    token: 'raw-token-value',
  })
  revokeShare.mockResolvedValue({ status: 'ok', share: SHARE_ROW, alreadyTerminal: false })
  supersedeOutstandingSharesForRotation.mockResolvedValue([SHARE_ROW])
  findExternalShareByTokenHash.mockResolvedValue({
    status: 'ok',
    metadata: {
      share: SHARE_ROW,
      credentialName: 'My Credential',
      credentialProjectId: PROJECT_ID,
      sharedByDisplayName: 'A teammate',
    },
  })
  revealExternalShare.mockResolvedValue({
    status: 'ok',
    share: SHARE_ROW,
    value: 'secret-value',
    valueFormat: 'scalar',
    fieldKey: null,
  })
  writeMachineAuditEntry.mockResolvedValue(undefined)
})

afterEach(() => {
  __resetCredentialSharingHostRateLimitForTests()
  __resetCredentialSharingOrgRateLimitForTests()
  vi.restoreAllMocks()
})

describe('buildCredentialSharingHost.createExternalShare (AC2)', () => {
  it('is a thin closure: calls createExternalCredentialShare with the resolved machine-user id as sharedByUserId, never a caller-supplied one', async () => {
    const host = buildCredentialSharingHost(MANIFEST)
    const result = await host.createExternalShare({
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      credentialId: CREDENTIAL_ID,
      recipientEmail: RECIPIENT_EMAIL,
      expiresAt: EXPIRES_AT_ISO,
    })

    expect(createExternalCredentialShare).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({
        orgId: ORG_ID,
        projectId: PROJECT_ID,
        credentialId: CREDENTIAL_ID,
        sharedByUserId: CREATED_BY_USER_ID,
        recipientEmail: RECIPIENT_EMAIL,
      })
    )
    expect(result).toEqual({
      status: 'ok',
      share: expect.objectContaining({ id: SHARE_ID, status: 'active' }),
      token: 'raw-token-value',
    })
  })

  it('writes a machine-attributed CREDENTIAL_SHARE_CREATED audit entry inside the same transaction', async () => {
    const host = buildCredentialSharingHost(MANIFEST)
    await host.createExternalShare({
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      credentialId: CREDENTIAL_ID,
      recipientEmail: RECIPIENT_EMAIL,
      expiresAt: EXPIRES_AT_ISO,
    })

    expect(writeMachineAuditEntry).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({
        orgId: ORG_ID,
        machineUserId: MACHINE_USER_ID,
        keyId: KEY_ID,
      })
    )
  })

  it('edge case: credential_not_found status passes through unmodified, no error thrown', async () => {
    createExternalCredentialShare.mockResolvedValue({ status: 'credential_not_found' })
    const host = buildCredentialSharingHost(MANIFEST)
    await expect(
      host.createExternalShare({
        organizationId: ORG_ID,
        projectId: PROJECT_ID,
        credentialId: CREDENTIAL_ID,
        recipientEmail: RECIPIENT_EMAIL,
        expiresAt: EXPIRES_AT_ISO,
      })
    ).resolves.toEqual({ status: 'credential_not_found' })
    expect(writeMachineAuditEntry).not.toHaveBeenCalled()
  })

  it('edge case: cap_exceeded status passes through unmodified', async () => {
    createExternalCredentialShare.mockResolvedValue({ status: 'cap_exceeded' })
    const host = buildCredentialSharingHost(MANIFEST)
    await expect(
      host.createExternalShare({
        organizationId: ORG_ID,
        projectId: PROJECT_ID,
        credentialId: CREDENTIAL_ID,
        recipientEmail: RECIPIENT_EMAIL,
        expiresAt: EXPIRES_AT_ISO,
      })
    ).resolves.toEqual({ status: 'cap_exceeded' })
  })

  it('Design Decision A: fails closed with CredentialSharingNoMachineUserError when no mapped machine-user exists for the org, no createExternalCredentialShare call', async () => {
    FAKE_TX.select = vi.fn(() => makeMachineUserSelectChain([]))
    const host = buildCredentialSharingHost(MANIFEST)

    await expect(
      host.createExternalShare({
        organizationId: ORG_ID,
        projectId: PROJECT_ID,
        credentialId: CREDENTIAL_ID,
        recipientEmail: RECIPIENT_EMAIL,
        expiresAt: EXPIRES_AT_ISO,
      })
    ).rejects.toBeInstanceOf(CredentialSharingNoMachineUserError)
    expect(createExternalCredentialShare).not.toHaveBeenCalled()
  })

  it('Design Decision A: fails closed when the only machine-user row is deactivated/revoked/expired', async () => {
    FAKE_TX.select = vi.fn(() =>
      makeMachineUserSelectChain([
        { ...liveMachineUserRow(), revokedAt: new Date('2020-01-01T00:00:00.000Z') },
      ])
    ) as never
    const host = buildCredentialSharingHost(MANIFEST)

    await expect(
      host.createExternalShare({
        organizationId: ORG_ID,
        projectId: PROJECT_ID,
        credentialId: CREDENTIAL_ID,
        recipientEmail: RECIPIENT_EMAIL,
        expiresAt: EXPIRES_AT_ISO,
      })
    ).rejects.toBeInstanceOf(CredentialSharingNoMachineUserError)
  })

  it('Design Decision A edge case: fails closed when the live machine-user row has no createdBy (cannot satisfy the shared_by NOT NULL FK)', async () => {
    FAKE_TX.select = vi.fn(() =>
      makeMachineUserSelectChain([{ ...liveMachineUserRow(), createdBy: null }])
    )
    const host = buildCredentialSharingHost(MANIFEST)

    await expect(
      host.createExternalShare({
        organizationId: ORG_ID,
        projectId: PROJECT_ID,
        credentialId: CREDENTIAL_ID,
        recipientEmail: RECIPIENT_EMAIL,
        expiresAt: EXPIRES_AT_ISO,
      })
    ).rejects.toBeInstanceOf(CredentialSharingNoMachineUserError)
    expect(createExternalCredentialShare).not.toHaveBeenCalled()
  })
})

describe('buildCredentialSharingHost.findShareByToken / revealShare (AC3)', () => {
  it('findShareByToken never accepts an organizationId argument (type-level: single rawToken:string param)', async () => {
    const host = buildCredentialSharingHost(MANIFEST)
    // @ts-expect-error — regression guard: findShareByToken must be callable with exactly one arg
    await host.findShareByToken('token', { organizationId: ORG_ID })
    expect(findExternalShareByTokenHash).toHaveBeenCalledWith('token')
  })

  it('revealShare never accepts an organizationId argument (type-level: single rawToken:string param)', async () => {
    const host = buildCredentialSharingHost(MANIFEST)
    // @ts-expect-error — regression guard: revealShare must be callable with exactly one arg
    await host.revealShare('token', { organizationId: ORG_ID })
    expect(revealExternalShare).toHaveBeenCalledWith('token')
  })

  it('findShareByToken: thin closure returning the resolved metadata on a valid token', async () => {
    const host = buildCredentialSharingHost(MANIFEST)
    const result = await host.findShareByToken(VALID_TOKEN)
    expect(result).toEqual({
      status: 'ok',
      share: expect.objectContaining({ id: SHARE_ID }),
      credentialName: 'My Credential',
      credentialProjectId: PROJECT_ID,
      sharedByDisplayName: 'A teammate',
    })
  })

  it('findShareByToken: not_found on an unresolvable/malformed/garbage token', async () => {
    findExternalShareByTokenHash.mockResolvedValue({ status: 'not_found' })
    const host = buildCredentialSharingHost(MANIFEST)
    await expect(host.findShareByToken('')).resolves.toEqual({ status: 'not_found' })
    await expect(host.findShareByToken('not-hex-garbage!!!')).resolves.toEqual({
      status: 'not_found',
    })
  })

  it('revealShare: thin closure returning the revealed value on a valid token', async () => {
    const host = buildCredentialSharingHost(MANIFEST)
    const result = await host.revealShare(VALID_TOKEN)
    expect(result).toEqual({
      status: 'ok',
      share: expect.objectContaining({ id: SHARE_ID }),
      value: 'secret-value',
      valueFormat: 'scalar',
      fieldKey: null,
    })
  })

  it('revealShare: not_found on an unresolvable/malformed/garbage token, never throws', async () => {
    findExternalShareByTokenHash.mockResolvedValue({ status: 'not_found' })
    revealExternalShare.mockResolvedValue({ status: 'not_found' })
    const host = buildCredentialSharingHost(MANIFEST)
    await expect(host.revealShare('')).resolves.toEqual({ status: 'not_found' })
    await expect(host.revealShare('not-hex-garbage!!!')).resolves.toEqual({ status: 'not_found' })
  })

  it('revealShare: already_viewed/expired/revoked statuses pass through unmodified', async () => {
    revealExternalShare.mockResolvedValue({ status: 'already_viewed' })
    const host = buildCredentialSharingHost(MANIFEST)
    await expect(host.revealShare('token')).resolves.toEqual({ status: 'already_viewed' })
  })

  it('AC5b: findShareByToken is rate-limited per resolved organizationId, throwing CredentialSharingOrgRateLimitedError', async () => {
    const host = buildCredentialSharingHost(
      MANIFEST,
      {},
      { orgRateLimits: { findShareByToken: 1 } }
    )
    await host.findShareByToken('token-1')
    await expect(host.findShareByToken('token-2')).rejects.toBeInstanceOf(
      CredentialSharingOrgRateLimitedError
    )
  })

  it('AC5b: revealShare is rate-limited per resolved organizationId, throwing CredentialSharingOrgRateLimitedError', async () => {
    const host = buildCredentialSharingHost(MANIFEST, {}, { orgRateLimits: { revealShare: 1 } })
    await host.revealShare('token-1')
    await expect(host.revealShare('token-2')).rejects.toBeInstanceOf(
      CredentialSharingOrgRateLimitedError
    )
  })

  it('AC5b: org rate limit is scoped per org — a different org is unaffected', async () => {
    const host = buildCredentialSharingHost(
      MANIFEST,
      {},
      { orgRateLimits: { findShareByToken: 1 } }
    )
    await host.findShareByToken('token-1')

    const otherOrgShare = { ...SHARE_ROW, orgId: OTHER_ORG_ID }
    findExternalShareByTokenHash.mockResolvedValue({
      status: 'ok',
      metadata: {
        share: otherOrgShare,
        credentialName: 'Other',
        credentialProjectId: PROJECT_ID,
        sharedByDisplayName: 'Someone',
      },
    })
    await expect(host.findShareByToken('token-in-other-org')).resolves.toMatchObject({
      status: 'ok',
    })
  })

  it('AC5b: an unresolved (not_found) token never counts against the per-org bucket', async () => {
    findExternalShareByTokenHash.mockResolvedValue({ status: 'not_found' })
    const host = buildCredentialSharingHost(
      MANIFEST,
      {},
      { orgRateLimits: { findShareByToken: 1 } }
    )
    await host.findShareByToken('garbage-1')
    await host.findShareByToken('garbage-2')
    await host.findShareByToken('garbage-3')
    // No throw — not_found lookups never resolve an org, so the org bucket is never touched.
  })

  // Fix (code review 2026-09-20): AC5's audit entry must carry `organizationId (once resolved)`
  // — previously findShareByToken/revealShare's 'ok' audit entry always recorded the literal
  // 'unresolved' placeholder, even after the org had been resolved from the token.
  it("AC5: findShareByToken's success audit entry carries the resolved organizationId, not the 'unresolved' placeholder", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }
    const host = buildCredentialSharingHost(MANIFEST, logger)
    await host.findShareByToken(VALID_TOKEN)
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG_ID,
        method: 'findShareByToken',
        outcome: 'ok',
      }),
      expect.any(String)
    )
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'unresolved', outcome: 'ok' }),
      expect.any(String)
    )
  })

  it("AC5: revealShare's success audit entry carries the resolved organizationId, not the 'unresolved' placeholder", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }
    const host = buildCredentialSharingHost(MANIFEST, logger)
    await host.revealShare(VALID_TOKEN)
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG_ID,
        method: 'revealShare',
        outcome: 'ok',
      }),
      expect.any(String)
    )
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'unresolved', outcome: 'ok' }),
      expect.any(String)
    )
  })

  // Fix (code review 2026-09-20): an org-rate-limit denial was previously audited twice — once by
  // enforceOrgRateLimit with the correct 'org-rate-limited' outcome, and again by
  // callOutOfRequestMethod's own catch block with a misleading generic 'error' outcome.
  it('AC5b: an org-rate-limit denial is audited exactly once, with outcome "org-rate-limited" (never a duplicate "error" entry)', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }
    const host = buildCredentialSharingHost(MANIFEST, logger, {
      orgRateLimits: { findShareByToken: 1 },
    })
    await host.findShareByToken('token-1')
    logger.info.mockClear()

    await expect(host.findShareByToken('token-2')).rejects.toBeInstanceOf(
      CredentialSharingOrgRateLimitedError
    )

    const auditCalls = logger.info.mock.calls.filter(
      ([fields]) =>
        typeof fields === 'object' && fields !== null && 'method' in fields && 'outcome' in fields
    )
    expect(auditCalls).toHaveLength(1)
    expect(auditCalls[0]?.[0]).toEqual(
      expect.objectContaining({
        organizationId: ORG_ID,
        method: 'findShareByToken',
        outcome: 'org-rate-limited',
      })
    )
  })

  // Code review 2026-09-20 (Medium finding, Nestor-confirmed as a required fix, not a judgment
  // call): the previous window-per-bucket counter reset its ENTIRE bucket once `windowMs` had
  // elapsed since the bucket's own `windowStart`, regardless of how recently the bucket's last
  // call landed. That let a full new burst of `max` calls straight through immediately after the
  // reset, even when the previous burst's last call was only milliseconds earlier — up to ~2x the
  // stated limit inside any real `windowMs` span. A true sliding window (recent-call timestamps,
  // pruned to `(now - windowMs, now]`) must still count those still-recent calls and reject.
  it('AC5b (sliding-window regression): a burst spanning a window reset is still rejected, unlike the old window-per-bucket counter', async () => {
    const timestamps = [0, 1, 1000, 1000]
    let callIndex = 0
    const now = () => timestamps[callIndex++] ?? (timestamps[timestamps.length - 1] as number)
    const host = buildCredentialSharingHost(
      MANIFEST,
      {},
      { orgRateLimits: { findShareByToken: 2, windowMs: 1000 }, now }
    )

    await host.findShareByToken('token-1') // t=0, count=1
    await host.findShareByToken('token-2') // t=1, count=2 (at the limit)
    // t=1000 — the old bucket (windowStart=0) had "expired" (1000 - 0 >= windowMs), so the old
    // window-per-bucket counter reset it and allowed a whole new burst of `max` calls straight
    // through, immediately after the t=1 call. A true sliding window still has the t=1 call
    // inside (0, 1000], so only ONE more call fits in the budget here.
    await expect(host.findShareByToken('token-3')).resolves.toMatchObject({ status: 'ok' }) // t=1000, count=2 (t=1 and t=1000 both in (0,1000])
    await expect(host.findShareByToken('token-4')).rejects.toBeInstanceOf(
      CredentialSharingOrgRateLimitedError
    ) // t=1000 again — bucket is already at the limit within the sliding window, must reject
  })

  it('AC5b (sliding-window): a call outside the window after the burst is allowed once old entries age out', async () => {
    const timestamps = [999, 999, 2000]
    let callIndex = 0
    const now = () => timestamps[callIndex++] ?? (timestamps[timestamps.length - 1] as number)
    const host = buildCredentialSharingHost(
      MANIFEST,
      {},
      { orgRateLimits: { findShareByToken: 2, windowMs: 1000 }, now }
    )

    await host.findShareByToken('token-1') // t=999
    await host.findShareByToken('token-2') // t=999, at the limit
    // t=2000 is more than windowMs (1000) after both prior calls, so they've aged out.
    await expect(host.findShareByToken('token-3')).resolves.toMatchObject({ status: 'ok' })
  })
})

describe('buildCredentialSharingHost.revokeShare (AC4)', () => {
  it('is a thin closure over service.ts#revokeShare', async () => {
    const host = buildCredentialSharingHost(MANIFEST)
    const result = await host.revokeShare({
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      credentialId: CREDENTIAL_ID,
      shareId: SHARE_ID,
    })

    expect(revokeShare).toHaveBeenCalledWith(FAKE_TX, {
      orgId: ORG_ID,
      credentialId: CREDENTIAL_ID,
      shareId: SHARE_ID,
    })
    expect(result).toEqual({
      status: 'ok',
      share: expect.objectContaining({ id: SHARE_ID }),
      alreadyTerminal: false,
    })
  })

  it('idempotent-no-op: revoking an already-terminal share returns alreadyTerminal:true, not an error, and writes no audit entry', async () => {
    revokeShare.mockResolvedValue({
      status: 'ok',
      share: { ...SHARE_ROW, status: 'viewed' },
      alreadyTerminal: true,
    })
    const host = buildCredentialSharingHost(MANIFEST)
    const result = await host.revokeShare({
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      credentialId: CREDENTIAL_ID,
      shareId: SHARE_ID,
    })
    expect(result).toEqual({
      status: 'ok',
      share: expect.objectContaining({ status: 'viewed' }),
      alreadyTerminal: true,
    })
    expect(writeMachineAuditEntry).not.toHaveBeenCalled()
  })

  it('edge case: not_found when the share does not exist in scope', async () => {
    revokeShare.mockResolvedValue({ status: 'not_found' })
    const host = buildCredentialSharingHost(MANIFEST)
    await expect(
      host.revokeShare({
        organizationId: ORG_ID,
        projectId: PROJECT_ID,
        credentialId: CREDENTIAL_ID,
        shareId: SHARE_ID,
      })
    ).resolves.toEqual({ status: 'not_found' })
  })

  it('Design Decision A: fails closed with CredentialSharingNoMachineUserError when no mapped machine-user exists', async () => {
    FAKE_TX.select = vi.fn(() => makeMachineUserSelectChain([]))
    const host = buildCredentialSharingHost(MANIFEST)
    await expect(
      host.revokeShare({
        organizationId: ORG_ID,
        projectId: PROJECT_ID,
        credentialId: CREDENTIAL_ID,
        shareId: SHARE_ID,
      })
    ).rejects.toBeInstanceOf(CredentialSharingNoMachineUserError)
    expect(revokeShare).not.toHaveBeenCalled()
  })

  it('writes a machine-attributed CREDENTIAL_SHARE_REVOKED audit entry on a real (non-idempotent) revoke', async () => {
    const host = buildCredentialSharingHost(MANIFEST)
    await host.revokeShare({
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      credentialId: CREDENTIAL_ID,
      shareId: SHARE_ID,
    })
    expect(writeMachineAuditEntry).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ machineUserId: MACHINE_USER_ID, keyId: KEY_ID })
    )
  })
})

describe('buildCredentialSharingHost.supersedeSharesForRotation (AC4)', () => {
  it('is a thin closure over supersedeOutstandingSharesForRotation, writing one audit entry per superseded share', async () => {
    const host = buildCredentialSharingHost(MANIFEST)
    const result = await host.supersedeSharesForRotation({
      organizationId: ORG_ID,
      credentialId: CREDENTIAL_ID,
      targetFields: null,
      rotationId: ROTATION_ID,
    })

    expect(supersedeOutstandingSharesForRotation).toHaveBeenCalledWith(FAKE_TX, {
      orgId: ORG_ID,
      credentialId: CREDENTIAL_ID,
      targetFields: null,
      rotationId: ROTATION_ID,
    })
    expect(result.supersededShares).toHaveLength(1)
    expect(writeMachineAuditEntry).toHaveBeenCalledTimes(1)
  })

  it('Design Decision A: fails closed with CredentialSharingNoMachineUserError when no mapped machine-user exists', async () => {
    FAKE_TX.select = vi.fn(() => makeMachineUserSelectChain([]))
    const host = buildCredentialSharingHost(MANIFEST)
    await expect(
      host.supersedeSharesForRotation({
        organizationId: ORG_ID,
        credentialId: CREDENTIAL_ID,
        targetFields: null,
        rotationId: ROTATION_ID,
      })
    ).rejects.toBeInstanceOf(CredentialSharingNoMachineUserError)
    expect(supersedeOutstandingSharesForRotation).not.toHaveBeenCalled()
  })

  it('no outstanding shares to supersede: returns an empty array, no audit entries written', async () => {
    supersedeOutstandingSharesForRotation.mockResolvedValue([])
    const host = buildCredentialSharingHost(MANIFEST)
    const result = await host.supersedeSharesForRotation({
      organizationId: ORG_ID,
      credentialId: CREDENTIAL_ID,
      targetFields: ['password'],
      rotationId: ROTATION_ID,
    })
    expect(result).toEqual({ supersededShares: [] })
    expect(writeMachineAuditEntry).not.toHaveBeenCalled()
  })
})

describe('buildCredentialSharingHost — AC5 per-extension in-flight rate limiting + audit logging', () => {
  it('rejects a call over the per-extension in-flight cap without invoking the underlying service, releasing the slot after each call', async () => {
    const host = buildCredentialSharingHost(MANIFEST, {}, { maxInFlight: 1 })
    let releaseFirst: (() => void) | undefined
    revokeShare.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve({ status: 'ok', share: SHARE_ROW, alreadyTerminal: false })
        })
    )

    const first = host.revokeShare({
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      credentialId: CREDENTIAL_ID,
      shareId: SHARE_ID,
    })
    await expect(
      host.revokeShare({
        organizationId: ORG_ID,
        projectId: PROJECT_ID,
        credentialId: CREDENTIAL_ID,
        shareId: SHARE_ID,
      })
    ).rejects.toBeInstanceOf(CredentialSharingRateLimitedError)

    expect(__getCredentialSharingHostInFlightCountForTests(MANIFEST.name)).toBe(1)
    releaseFirst?.()
    await first
    expect(__getCredentialSharingHostInFlightCountForTests(MANIFEST.name)).toBe(0)
  })

  it('records an audit log entry with outcome "ok" on success', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }
    const host = buildCredentialSharingHost(MANIFEST, logger)
    await host.revokeShare({
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      credentialId: CREDENTIAL_ID,
      shareId: SHARE_ID,
    })
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG_ID,
        extensionName: MANIFEST.name,
        method: 'revokeShare',
        outcome: 'ok',
      }),
      expect.any(String)
    )
  })

  it('records an audit log entry with outcome "rate-limited" on denial', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }
    const host = buildCredentialSharingHost(MANIFEST, logger, { maxInFlight: 1 })
    let releaseFirst: (() => void) | undefined
    revokeShare.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve({ status: 'ok', share: SHARE_ROW, alreadyTerminal: false })
        })
    )
    const first = host.revokeShare({
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      credentialId: CREDENTIAL_ID,
      shareId: SHARE_ID,
    })
    await expect(
      host.revokeShare({
        organizationId: ORG_ID,
        projectId: PROJECT_ID,
        credentialId: CREDENTIAL_ID,
        shareId: SHARE_ID,
      })
    ).rejects.toBeInstanceOf(CredentialSharingRateLimitedError)

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG_ID,
        extensionName: MANIFEST.name,
        method: 'revokeShare',
        outcome: 'rate-limited',
      }),
      expect.any(String)
    )
    releaseFirst?.()
    await first
  })

  it('records an audit log entry with outcome "error" when the service layer throws', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }
    const host = buildCredentialSharingHost(MANIFEST, logger)
    const dbError = new Error('boom')
    revokeShare.mockRejectedValue(dbError)

    await expect(
      host.revokeShare({
        organizationId: ORG_ID,
        projectId: PROJECT_ID,
        credentialId: CREDENTIAL_ID,
        shareId: SHARE_ID,
      })
    ).rejects.toThrow(dbError)

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG_ID,
        extensionName: MANIFEST.name,
        method: 'revokeShare',
        outcome: 'error',
      }),
      expect.any(String)
    )
  })

  it('every credentialSharing method shares the same per-extension in-flight budget (not per-method)', async () => {
    const host = buildCredentialSharingHost(MANIFEST, {}, { maxInFlight: 1 })
    let releaseCreate: (() => void) | undefined
    createExternalCredentialShare.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCreate = () => resolve({ status: 'ok', share: SHARE_ROW, token: 'tok' })
        })
    )

    const createCall = host.createExternalShare({
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      credentialId: CREDENTIAL_ID,
      recipientEmail: RECIPIENT_EMAIL,
      expiresAt: EXPIRES_AT_ISO,
    })
    await expect(
      host.revokeShare({
        organizationId: ORG_ID,
        projectId: PROJECT_ID,
        credentialId: CREDENTIAL_ID,
        shareId: SHARE_ID,
      })
    ).rejects.toBeInstanceOf(CredentialSharingRateLimitedError)

    releaseCreate?.()
    await createCall
  })
})
