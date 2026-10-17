import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionManifest } from '@project-vault/extension-api'
import {
  CredentialSharingActingUserInvalidError,
  CredentialSharingActingUserMismatchError,
  CredentialSharingNoMachineUserError,
  CredentialSharingNotAuthorizedError,
  CredentialSharingOrgRateLimitedError,
  CredentialSharingRateLimitedError,
} from '@project-vault/extension-api'
import { OperationalEvent } from '@project-vault/shared'
import { firstRejection, redeemInBatches } from '../__tests__/helpers/redeem-in-batches.js'
import { runWithRequestContext } from './request-context.js'

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

const { resolveActiveOrgRoleInTx } = vi.hoisted(() => ({ resolveActiveOrgRoleInTx: vi.fn() }))
vi.mock('../plugins/authenticate.js', () => ({ resolveActiveOrgRoleInTx }))

const {
  findShareInScope,
  revokeShare,
  supersedeOutstandingSharesForRotation,
  listSharesForCredential,
  countSharesForCredential,
  listSharesForOrganization,
  countSharesForOrganization,
} = vi.hoisted(() => ({
  findShareInScope: vi.fn(),
  revokeShare: vi.fn(),
  supersedeOutstandingSharesForRotation: vi.fn(),
  listSharesForCredential: vi.fn(),
  countSharesForCredential: vi.fn(),
  listSharesForOrganization: vi.fn(),
  countSharesForOrganization: vi.fn(),
}))
vi.mock('../modules/credential-shares/service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../modules/credential-shares/service.js')>()
  return {
    ...actual,
    findShareInScope,
    revokeShare,
    supersedeOutstandingSharesForRotation,
    listSharesForCredential,
    countSharesForCredential,
    listSharesForOrganization,
    countSharesForOrganization,
  }
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
const USER_U = '99999999-9999-9999-9999-999999999991'
const USER_V = '99999999-9999-9999-9999-999999999992'
const USER_W = '99999999-9999-9999-9999-999999999993'
/* eslint-enable no-secrets/no-secrets */
const VALID_TOKEN = 'valid-token'
const RECIPIENT_EMAIL = 'recipient@invalid'
const EXPIRES_AT_ISO = '2026-01-02T00:00:00.000Z'
const ROTATION_ID = 'rotation-1'
const RAW_TOKEN = 'raw-token-value'
const CREDENTIAL_NAME = 'My Credential'
const DISPLAY_NAME = 'A teammate'

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
    token: RAW_TOKEN,
  })
  revokeShare.mockResolvedValue({ status: 'ok', share: SHARE_ROW, alreadyTerminal: false })
  supersedeOutstandingSharesForRotation.mockResolvedValue([SHARE_ROW])
  listSharesForCredential.mockResolvedValue([SHARE_ROW])
  countSharesForCredential.mockResolvedValue(1)
  listSharesForOrganization.mockResolvedValue([SHARE_ROW])
  countSharesForOrganization.mockResolvedValue(1)
  findExternalShareByTokenHash.mockResolvedValue({
    status: 'ok',
    metadata: {
      share: SHARE_ROW,
      credentialName: CREDENTIAL_NAME,
      credentialProjectId: PROJECT_ID,
      sharedByDisplayName: DISPLAY_NAME,
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
  findShareInScope.mockResolvedValue(SHARE_ROW)
  resolveActiveOrgRoleInTx.mockResolvedValue('member')
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
      token: RAW_TOKEN,
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
    // Story 65.4: the second argument is the host's own logger for the deferred write, never an
    // organization id.
    const [call] = vi.mocked(revealExternalShare).mock.calls
    expect(call?.[0]).toBe('token')
    expect(JSON.stringify(call)).not.toContain(ORG_ID)
  })

  it('findShareByToken: thin closure returning the resolved metadata on a valid token', async () => {
    const host = buildCredentialSharingHost(MANIFEST)
    const result = await host.findShareByToken(VALID_TOKEN)
    expect(result).toEqual({
      status: 'ok',
      share: expect.objectContaining({ id: SHARE_ID }),
      credentialName: CREDENTIAL_NAME,
      credentialProjectId: PROJECT_ID,
      sharedByDisplayName: DISPLAY_NAME,
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
    // Bucket limit is 1 — if a not_found lookup counted against it, the 2nd/3rd calls below
    // would throw CredentialSharingOrgRateLimitedError. All three resolving proves the bucket
    // was never touched, since a real org can never be resolved from an unmatched token.
    await expect(host.findShareByToken('garbage-1')).resolves.toMatchObject({
      status: 'not_found',
    })
    await expect(host.findShareByToken('garbage-2')).resolves.toMatchObject({
      status: 'not_found',
    })
    await expect(host.findShareByToken('garbage-3')).resolves.toMatchObject({
      status: 'not_found',
    })
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

describe('buildCredentialSharingHost.listSharesForCredential (AC8, AC10)', () => {
  it('is a thin closure: calls listSharesForCredential/countSharesForCredential with the credential-scoped params, no sharedByUserId field', async () => {
    const host = buildCredentialSharingHost(MANIFEST)
    const result = await host.listSharesForCredential({
      organizationId: ORG_ID,
      credentialId: CREDENTIAL_ID,
      status: 'active',
      limit: 10,
      offset: 0,
    })

    const expectedParams = {
      orgId: ORG_ID,
      credentialId: CREDENTIAL_ID,
      status: 'active',
      limit: 10,
      offset: 0,
    }
    expect(listSharesForCredential).toHaveBeenCalledWith(FAKE_TX, expectedParams)
    expect(countSharesForCredential).toHaveBeenCalledWith(FAKE_TX, expectedParams)
    expect(listSharesForCredential.mock.calls[0]?.[1]).not.toHaveProperty('sharedByUserId')
    expect(result).toEqual({
      status: 'ok',
      items: [expect.objectContaining({ id: SHARE_ID, status: 'active' })],
      total: 1,
    })
  })

  it('edge case: an empty result set returns { status: "ok", items: [], total: 0 }, not an error', async () => {
    listSharesForCredential.mockResolvedValue([])
    countSharesForCredential.mockResolvedValue(0)
    const host = buildCredentialSharingHost(MANIFEST)
    const result = await host.listSharesForCredential({
      organizationId: ORG_ID,
      credentialId: CREDENTIAL_ID,
    })
    expect(result).toEqual({ status: 'ok', items: [], total: 0 })
  })
})

describe('buildCredentialSharingHost.listSharesForOrganization (AC9, AC10)', () => {
  it('is a thin closure: calls listSharesForOrganization/countSharesForOrganization org-scoped only, no credentialId filter', async () => {
    const host = buildCredentialSharingHost(MANIFEST)
    const result = await host.listSharesForOrganization({
      organizationId: ORG_ID,
      status: 'active',
      limit: 25,
      offset: 5,
    })

    const expectedParams = { orgId: ORG_ID, status: 'active', limit: 25, offset: 5 }
    expect(listSharesForOrganization).toHaveBeenCalledWith(FAKE_TX, expectedParams)
    expect(countSharesForOrganization).toHaveBeenCalledWith(FAKE_TX, expectedParams)
    expect(listSharesForOrganization.mock.calls[0]?.[1]).not.toHaveProperty('credentialId')
    expect(result).toEqual({
      status: 'ok',
      items: [expect.objectContaining({ id: SHARE_ID })],
      total: 1,
    })
  })

  it('edge case: an org with zero shares returns { status: "ok", items: [], total: 0 }', async () => {
    listSharesForOrganization.mockResolvedValue([])
    countSharesForOrganization.mockResolvedValue(0)
    const host = buildCredentialSharingHost(MANIFEST)
    const result = await host.listSharesForOrganization({ organizationId: ORG_ID })
    expect(result).toEqual({ status: 'ok', items: [], total: 0 })
  })

  it('AC11: goes through the same per-extension in-flight cap as every other method, no new bucket', async () => {
    const host = buildCredentialSharingHost(MANIFEST, {}, { maxInFlight: 1 })
    let releaseFirst: (() => void) | undefined
    listSharesForOrganization.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve([SHARE_ROW])
        })
    )

    const first = host.listSharesForOrganization({ organizationId: ORG_ID })
    await expect(host.listSharesForOrganization({ organizationId: ORG_ID })).rejects.toBeInstanceOf(
      CredentialSharingRateLimitedError
    )
    expect(__getCredentialSharingHostInFlightCountForTests(MANIFEST.name)).toBe(1)
    releaseFirst?.()
    await first
    expect(__getCredentialSharingHostInFlightCountForTests(MANIFEST.name)).toBe(0)
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

describe('buildCredentialSharingHost miss floor (Story 65.4 AC1)', () => {
  const FLOOR = 100

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Settles `call` and reports how many fake ms it took (or that it never settled in `limit`). */
  async function settleWithin(call: Promise<unknown>, limitMs: number) {
    let settled = false
    const tracked = call.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await vi.advanceTimersByTimeAsync(limitMs)
    return { settled, tracked }
  }

  it('findShareByToken holds a not_found until the floor and returns the same value', async () => {
    findExternalShareByTokenHash.mockResolvedValue({ status: 'not_found' })
    const host = buildCredentialSharingHost(MANIFEST)
    const call = host.findShareByToken('garbage')
    expect((await settleWithin(call, FLOOR - 1)).settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(call).resolves.toEqual({ status: 'not_found' })
  })

  it.each(['expired', 'revoked', 'viewed', 'superseded'] as const)(
    'findShareByToken holds a %s share like a miss (the dead-link class)',
    async (status) => {
      const found = await findExternalShareByTokenHash(VALID_TOKEN)
      findExternalShareByTokenHash.mockResolvedValue({
        ...found,
        metadata: { ...found.metadata, share: { ...SHARE_ROW, status } },
      })
      const host = buildCredentialSharingHost(MANIFEST)
      const call = host.findShareByToken(VALID_TOKEN)
      expect((await settleWithin(call, FLOOR - 1)).settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(call).resolves.toMatchObject({ status: 'ok' })
    }
  )

  it('findShareByToken never delays an active share (a hit)', async () => {
    const host = buildCredentialSharingHost(MANIFEST)
    const call = host.findShareByToken(VALID_TOKEN)
    expect((await settleWithin(call, 0)).settled).toBe(true)
    await expect(call).resolves.toMatchObject({ status: 'ok' })
  })

  it('revealShare holds every non-ok outcome and never delays a hit', async () => {
    const revealed = await revealExternalShare(VALID_TOKEN)
    revealExternalShare.mockResolvedValue({ status: 'revoked' })
    const host = buildCredentialSharingHost(MANIFEST)
    const miss = host.revealShare('token')
    expect((await settleWithin(miss, FLOOR - 1)).settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(miss).resolves.toEqual({ status: 'revoked' })

    revealExternalShare.mockResolvedValue(revealed)
    const hit = host.revealShare('token')
    expect((await settleWithin(hit, 0)).settled).toBe(true)
  })

  it('holds the per-org rate-limit rejection like any other miss, then rethrows it', async () => {
    const host = buildCredentialSharingHost(MANIFEST, {}, { orgRateLimits: { revealShare: 1 } })
    await host.revealShare('token-1')
    await vi.advanceTimersByTimeAsync(0)

    const limited = host.revealShare('token-2').then(
      () => 'resolved',
      (error: unknown) => error
    )
    await vi.advanceTimersByTimeAsync(FLOOR - 1)
    let early = false
    void limited.then(() => {
      early = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(early).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await limited).toBeInstanceOf(CredentialSharingOrgRateLimitedError)
  })

  it('an unrelated thrown error is not held', async () => {
    findExternalShareByTokenHash.mockRejectedValue(new Error('db down'))
    const host = buildCredentialSharingHost(MANIFEST)
    const call = host.findShareByToken('token').catch((error: unknown) => error)
    expect((await settleWithin(call, 0)).settled).toBe(true)
    expect(await call).toBeInstanceOf(Error)
  })

  it('a held call keeps counting once in the in-flight accounting until it is released', async () => {
    findExternalShareByTokenHash.mockResolvedValue({ status: 'not_found' })
    const host = buildCredentialSharingHost(MANIFEST, {}, { maxInFlight: 1 })
    const first = host.findShareByToken('garbage-1')
    await vi.advanceTimersByTimeAsync(10)
    expect(__getCredentialSharingHostInFlightCountForTests(MANIFEST.name)).toBe(1)
    await expect(host.findShareByToken('garbage-2')).rejects.toBeInstanceOf(
      CredentialSharingRateLimitedError
    )
    await vi.advanceTimersByTimeAsync(FLOOR)
    await first
    expect(__getCredentialSharingHostInFlightCountForTests(MANIFEST.name)).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------
// Story 65.6 — acting user (D1 resolution order), `sharedBy`, `viewer` and `actor`.
// ---------------------------------------------------------------------------------------------

const CREATE_PARAMS = {
  organizationId: ORG_ID,
  projectId: PROJECT_ID,
  credentialId: CREDENTIAL_ID,
  recipientEmail: RECIPIENT_EMAIL,
  expiresAt: EXPIRES_AT_ISO,
}
const REVOKE_PARAMS = {
  organizationId: ORG_ID,
  projectId: PROJECT_ID,
  credentialId: CREDENTIAL_ID,
  shareId: SHARE_ID,
}

function hostRow(actingUserId: string | null) {
  return { ...SHARE_ROW, hostCreated: true, actingUserId }
}

function insertedInput(): Record<string, unknown> {
  return createExternalCredentialShare.mock.calls[0]?.[1] as Record<string, unknown>
}

describe('Story 65.6 AC1/D1: createExternalShare resolves the acting user', () => {
  it('ambient request user wins: recorded as actingUserId, shared_by stays the provisioning human, audit stays the machine user', async () => {
    createExternalCredentialShare.mockResolvedValue({
      status: 'ok',
      share: hostRow(USER_U),
      token: RAW_TOKEN,
    })
    const host = buildCredentialSharingHost(MANIFEST)
    const result = await runWithRequestContext({ orgId: ORG_ID, userId: USER_U }, () =>
      host.createExternalShare(CREATE_PARAMS)
    )

    expect(insertedInput()).toMatchObject({
      sharedByUserId: CREATED_BY_USER_ID,
      hostCreated: true,
      actingUserId: USER_U,
    })
    expect(writeMachineAuditEntry).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ machineUserId: MACHINE_USER_ID, keyId: KEY_ID })
    )
    expect(result).toMatchObject({ status: 'ok', share: { sharedBy: USER_U } })
    expect(resolveActiveOrgRoleInTx).not.toHaveBeenCalled()
  })

  it('ambient user and an equal actingUserId is fine', async () => {
    const host = buildCredentialSharingHost(MANIFEST)
    await runWithRequestContext({ orgId: ORG_ID, userId: USER_U }, () =>
      host.createExternalShare({ ...CREATE_PARAMS, actingUserId: USER_U })
    )
    expect(insertedInput()).toMatchObject({ actingUserId: USER_U })
  })

  it('no ambient user: a supplied actingUserId that is an active member is recorded', async () => {
    resolveActiveOrgRoleInTx.mockResolvedValue('member')
    const host = buildCredentialSharingHost(MANIFEST)
    await host.createExternalShare({ ...CREATE_PARAMS, actingUserId: USER_V })

    expect(resolveActiveOrgRoleInTx).toHaveBeenCalledWith(FAKE_TX, USER_V, ORG_ID)
    expect(insertedInput()).toMatchObject({ hostCreated: true, actingUserId: USER_V })
  })

  it('neither: created as today, host_created with an unknown acting user, sharedBy reads back null', async () => {
    createExternalCredentialShare.mockResolvedValue({
      status: 'ok',
      share: hostRow(null),
      token: RAW_TOKEN,
    })
    const host = buildCredentialSharingHost(MANIFEST)
    const result = await host.createExternalShare(CREATE_PARAMS)

    expect(insertedInput()).toMatchObject({
      sharedByUserId: CREATED_BY_USER_ID,
      hostCreated: true,
      actingUserId: null,
    })
    expect(resolveActiveOrgRoleInTx).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: 'ok', share: { sharedBy: null } })
  })

  it.each([
    ['not a member of the org', null],
    ['only a viewer role', 'viewer'],
  ])(
    'no ambient user and an actingUserId that is %s: one generic invalid error, nothing written',
    async (_label, role) => {
      resolveActiveOrgRoleInTx.mockResolvedValue(role)
      const host = buildCredentialSharingHost(MANIFEST)
      const rejection = await host
        .createExternalShare({ ...CREATE_PARAMS, actingUserId: USER_V })
        .then(
          () => undefined,
          (error: unknown) => error
        )

      expect(rejection).toBeInstanceOf(CredentialSharingActingUserInvalidError)
      expect((rejection as Error).message).not.toContain(USER_V)
      expect((rejection as Error).message).not.toContain(ORG_ID)
      expect(createExternalCredentialShare).not.toHaveBeenCalled()
      expect(writeMachineAuditEntry).not.toHaveBeenCalled()
    }
  )

  it('ambient user U and a different actingUserId V: mismatch error, nothing written', async () => {
    const host = buildCredentialSharingHost(MANIFEST)
    await expect(
      runWithRequestContext({ orgId: ORG_ID, userId: USER_U }, () =>
        host.createExternalShare({ ...CREATE_PARAMS, actingUserId: USER_V })
      )
    ).rejects.toBeInstanceOf(CredentialSharingActingUserMismatchError)
    expect(createExternalCredentialShare).not.toHaveBeenCalled()
    expect(writeMachineAuditEntry).not.toHaveBeenCalled()
  })

  it('an ambient context bound for a DIFFERENT org is never trusted: treated as absent', async () => {
    const host = buildCredentialSharingHost(MANIFEST)
    await runWithRequestContext({ orgId: OTHER_ORG_ID, userId: USER_U }, () =>
      host.createExternalShare(CREATE_PARAMS)
    )
    expect(insertedInput()).toMatchObject({ hostCreated: true, actingUserId: null })

    createExternalCredentialShare.mockClear()
    await runWithRequestContext({ orgId: OTHER_ORG_ID, userId: USER_U }, () =>
      host.createExternalShare({ ...CREATE_PARAMS, actingUserId: USER_V })
    )
    expect(resolveActiveOrgRoleInTx).toHaveBeenCalledWith(FAKE_TX, USER_V, ORG_ID)
    expect(insertedInput()).toMatchObject({ actingUserId: USER_V })
  })

  it('an ambient context with no userId (unlinked delegated actor) is treated as absent', async () => {
    const host = buildCredentialSharingHost(MANIFEST)
    await runWithRequestContext({ orgId: ORG_ID }, () => host.createExternalShare(CREATE_PARAMS))
    expect(insertedInput()).toMatchObject({ hostCreated: true, actingUserId: null })
  })

  it('the machine-user check still runs first and fails closed before the acting user is resolved', async () => {
    FAKE_TX.select = vi.fn(() => makeMachineUserSelectChain([]))
    const host = buildCredentialSharingHost(MANIFEST)
    await expect(
      host.createExternalShare({ ...CREATE_PARAMS, actingUserId: USER_V })
    ).rejects.toBeInstanceOf(CredentialSharingNoMachineUserError)
    expect(resolveActiveOrgRoleInTx).not.toHaveBeenCalled()
  })
})

describe('Story 65.6 AC3/AC3b: sharedBy on every extension share record', () => {
  it('a native row reports shared_by; a host row reports the acting user or null; the key is always present', async () => {
    listSharesForOrganization.mockResolvedValue([
      { ...SHARE_ROW, hostCreated: false, actingUserId: null, sharedBy: USER_W },
      hostRow(USER_U),
      hostRow(null),
    ])
    countSharesForOrganization.mockResolvedValue(3)
    const host = buildCredentialSharingHost(MANIFEST)
    const { items } = await host.listSharesForOrganization({ organizationId: ORG_ID })

    expect(items.map((item) => item.sharedBy)).toEqual([USER_W, USER_U, null])
    for (const item of items) expect(Object.keys(item)).toContain('sharedBy')
    expect(JSON.parse(JSON.stringify(items[2]))).toHaveProperty('sharedBy', null)
  })

  it('revokeShare and supersedeSharesForRotation records carry sharedBy too', async () => {
    revokeShare.mockResolvedValue({
      status: 'ok',
      share: hostRow(USER_U),
      alreadyTerminal: false,
    })
    supersedeOutstandingSharesForRotation.mockResolvedValue([hostRow(null)])
    const host = buildCredentialSharingHost(MANIFEST)

    const revoked = await host.revokeShare(REVOKE_PARAMS)
    expect(revoked).toMatchObject({ status: 'ok', share: { sharedBy: USER_U } })
    const superseded = await host.supersedeSharesForRotation({
      organizationId: ORG_ID,
      credentialId: CREDENTIAL_ID,
      targetFields: null,
      rotationId: ROTATION_ID,
    })
    expect(superseded.supersededShares[0]).toHaveProperty('sharedBy', null)
  })

  it('findShareByToken and revealShare records carry sharedBy and do no membership lookup', async () => {
    findExternalShareByTokenHash.mockResolvedValue({
      status: 'ok',
      metadata: {
        share: hostRow(USER_U),
        credentialName: CREDENTIAL_NAME,
        credentialProjectId: PROJECT_ID,
        sharedByDisplayName: DISPLAY_NAME,
      },
    })
    revealExternalShare.mockResolvedValue({
      status: 'ok',
      share: hostRow(USER_U),
      value: 'v',
      valueFormat: 'scalar',
      fieldKey: null,
    })
    const host = buildCredentialSharingHost(MANIFEST)
    expect(await host.findShareByToken(VALID_TOKEN)).toMatchObject({ share: { sharedBy: USER_U } })
    expect(await host.revealShare(VALID_TOKEN)).toMatchObject({ share: { sharedBy: USER_U } })
    expect(resolveActiveOrgRoleInTx).not.toHaveBeenCalled()
  })
})

describe('Story 65.6 AC4: viewer on the list methods', () => {
  it('no viewer: unchanged admin-equivalent query, no membership lookup, no scoping key', async () => {
    const host = buildCredentialSharingHost(MANIFEST)
    await host.listSharesForCredential({ organizationId: ORG_ID, credentialId: CREDENTIAL_ID })
    expect(resolveActiveOrgRoleInTx).not.toHaveBeenCalled()
    const params = listSharesForCredential.mock.calls[0]?.[1] as Record<string, unknown>
    expect(params).not.toHaveProperty('extensionViewerUserId')
    expect(params).not.toHaveProperty('sharedByUserId')
  })

  it.each(['admin', 'owner'])('a %s viewer sees every share in scope', async (role) => {
    resolveActiveOrgRoleInTx.mockResolvedValue(role)
    const host = buildCredentialSharingHost(MANIFEST)
    const result = await host.listSharesForOrganization({
      organizationId: ORG_ID,
      viewer: { userId: USER_U },
    })
    expect(result.total).toBe(1)
    expect(listSharesForOrganization.mock.calls[0]?.[1]).not.toHaveProperty('extensionViewerUserId')
  })

  it('a member viewer is scoped to their own shares in both the list and the count query', async () => {
    resolveActiveOrgRoleInTx.mockResolvedValue('member')
    const host = buildCredentialSharingHost(MANIFEST)
    await host.listSharesForCredential({
      organizationId: ORG_ID,
      credentialId: CREDENTIAL_ID,
      status: 'active',
      viewer: { userId: USER_U },
    })
    expect(listSharesForCredential).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ status: 'active', extensionViewerUserId: USER_U })
    )
    expect(countSharesForCredential).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ extensionViewerUserId: USER_U })
    )

    await host.listSharesForOrganization({ organizationId: ORG_ID, viewer: { userId: USER_U } })
    expect(countSharesForOrganization).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ extensionViewerUserId: USER_U })
    )
  })

  it.each([
    ['is not an active member', null],
    ['has only the viewer role', 'viewer'],
  ])('a viewer who %s gets an empty list, never an error, and no query runs', async (_l, role) => {
    resolveActiveOrgRoleInTx.mockResolvedValue(role)
    const host = buildCredentialSharingHost(MANIFEST)
    await expect(
      host.listSharesForCredential({
        organizationId: ORG_ID,
        credentialId: CREDENTIAL_ID,
        viewer: { userId: USER_U },
      })
    ).resolves.toEqual({ status: 'ok', items: [], total: 0 })
    await expect(
      host.listSharesForOrganization({ organizationId: ORG_ID, viewer: { userId: USER_U } })
    ).resolves.toEqual({ status: 'ok', items: [], total: 0 })
    expect(listSharesForCredential).not.toHaveBeenCalled()
    expect(listSharesForOrganization).not.toHaveBeenCalled()
  })

  it('a viewer differing from the ambient request user is a mismatch error; an equal one resolves', async () => {
    const host = buildCredentialSharingHost(MANIFEST)
    await expect(
      runWithRequestContext({ orgId: ORG_ID, userId: USER_U }, () =>
        host.listSharesForOrganization({ organizationId: ORG_ID, viewer: { userId: USER_V } })
      )
    ).rejects.toBeInstanceOf(CredentialSharingActingUserMismatchError)
    await expect(
      runWithRequestContext({ orgId: ORG_ID, userId: USER_U }, () =>
        host.listSharesForOrganization({ organizationId: ORG_ID, viewer: { userId: USER_U } })
      )
    ).resolves.toMatchObject({ status: 'ok' })
  })
})

describe('Story 65.6 AC5: actor on revokeShare', () => {
  it('without actor: unchanged (no lookup, no authorization)', async () => {
    findShareInScope.mockResolvedValue(hostRow(null))
    const host = buildCredentialSharingHost(MANIFEST)
    await expect(host.revokeShare(REVOKE_PARAMS)).resolves.toMatchObject({ status: 'ok' })
    expect(findShareInScope).not.toHaveBeenCalled()
    expect(resolveActiveOrgRoleInTx).not.toHaveBeenCalled()
  })

  it('the share sharer (known acting user) may revoke', async () => {
    findShareInScope.mockResolvedValue(hostRow(USER_U))
    const host = buildCredentialSharingHost(MANIFEST)
    await expect(
      host.revokeShare({ ...REVOKE_PARAMS, actor: { userId: USER_U } })
    ).resolves.toMatchObject({ status: 'ok', alreadyTerminal: false })
    expect(writeMachineAuditEntry).toHaveBeenCalledTimes(1)
  })

  it('the shared_by of a native row may revoke it', async () => {
    findShareInScope.mockResolvedValue({
      ...SHARE_ROW,
      hostCreated: false,
      actingUserId: null,
      sharedBy: USER_U,
    })
    const host = buildCredentialSharingHost(MANIFEST)
    await expect(
      host.revokeShare({ ...REVOKE_PARAMS, actor: { userId: USER_U } })
    ).resolves.toMatchObject({ status: 'ok' })
  })

  it.each(['admin', 'owner'])('an org %s may revoke anyone else’s share', async (role) => {
    findShareInScope.mockResolvedValue(hostRow(USER_U))
    resolveActiveOrgRoleInTx.mockResolvedValue(role)
    const host = buildCredentialSharingHost(MANIFEST)
    await expect(
      host.revokeShare({ ...REVOKE_PARAMS, actor: { userId: USER_W } })
    ).resolves.toMatchObject({ status: 'ok' })
  })

  it('a non-sharer member is rejected before any mutation or audit write', async () => {
    findShareInScope.mockResolvedValue(hostRow(USER_U))
    const host = buildCredentialSharingHost(MANIFEST)
    await expect(
      host.revokeShare({ ...REVOKE_PARAMS, actor: { userId: USER_W } })
    ).rejects.toBeInstanceOf(CredentialSharingNotAuthorizedError)
    expect(revokeShare).not.toHaveBeenCalled()
    expect(writeMachineAuditEntry).not.toHaveBeenCalled()
  })

  it('a legacy host row with an unknown acting user is admin/owner only (the provisioner is not the sharer)', async () => {
    findShareInScope.mockResolvedValue({ ...hostRow(null), sharedBy: CREATED_BY_USER_ID })
    const host = buildCredentialSharingHost(MANIFEST)
    await expect(
      host.revokeShare({ ...REVOKE_PARAMS, actor: { userId: CREATED_BY_USER_ID } })
    ).rejects.toBeInstanceOf(CredentialSharingNotAuthorizedError)
    expect(revokeShare).not.toHaveBeenCalled()

    resolveActiveOrgRoleInTx.mockResolvedValue('admin')
    await expect(
      host.revokeShare({ ...REVOKE_PARAMS, actor: { userId: CREATED_BY_USER_ID } })
    ).resolves.toMatchObject({ status: 'ok' })
  })

  it('an actor who is not an active org member gets the generic invalid error, before the share is looked up', async () => {
    resolveActiveOrgRoleInTx.mockResolvedValue(null)
    const host = buildCredentialSharingHost(MANIFEST)
    await expect(
      host.revokeShare({ ...REVOKE_PARAMS, actor: { userId: USER_W } })
    ).rejects.toBeInstanceOf(CredentialSharingActingUserInvalidError)
    expect(findShareInScope).not.toHaveBeenCalled()
    expect(revokeShare).not.toHaveBeenCalled()
  })

  it('an actor differing from the ambient request user is a mismatch error', async () => {
    const host = buildCredentialSharingHost(MANIFEST)
    await expect(
      runWithRequestContext({ orgId: ORG_ID, userId: USER_U }, () =>
        host.revokeShare({ ...REVOKE_PARAMS, actor: { userId: USER_W } })
      )
    ).rejects.toBeInstanceOf(CredentialSharingActingUserMismatchError)
    expect(findShareInScope).not.toHaveBeenCalled()
  })

  it('a share not found in scope is not_found, checked before authorization', async () => {
    findShareInScope.mockResolvedValue(null)
    const host = buildCredentialSharingHost(MANIFEST)
    await expect(
      host.revokeShare({ ...REVOKE_PARAMS, actor: { userId: USER_W } })
    ).resolves.toEqual({ status: 'not_found' })
    expect(revokeShare).not.toHaveBeenCalled()
  })

  it('authorization is evaluated before terminal state: unauthorized + already-terminal is still not-authorized; authorized is the idempotent no-op', async () => {
    findShareInScope.mockResolvedValue({ ...hostRow(USER_U), status: 'viewed' })
    revokeShare.mockResolvedValue({
      status: 'ok',
      share: { ...hostRow(USER_U), status: 'viewed' },
      alreadyTerminal: true,
    })
    const host = buildCredentialSharingHost(MANIFEST)
    await expect(
      host.revokeShare({ ...REVOKE_PARAMS, actor: { userId: USER_W } })
    ).rejects.toBeInstanceOf(CredentialSharingNotAuthorizedError)
    await expect(
      host.revokeShare({ ...REVOKE_PARAMS, actor: { userId: USER_U } })
    ).resolves.toMatchObject({ status: 'ok', alreadyTerminal: true })
    expect(writeMachineAuditEntry).not.toHaveBeenCalled()
  })
})

describe('buildCredentialSharingHost org budget charges only ACTIVE shares (Story 65.5, DW-346)', () => {
  const TERMINAL_STATUSES = ['revoked', 'viewed', 'expired', 'superseded'] as const
  const FLOOR_MS = 100
  const BURST = 100
  const DEAD_TOKEN = 'dead-token'
  const ACTIVE_TOKEN = 'active-token'
  const OTHER_ORG_TOKEN = 'other-token'
  const BURST_VALUE = 'burst-value'

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function lookupResult(share: Record<string, unknown>) {
    return {
      status: 'ok' as const,
      metadata: {
        share,
        credentialName: CREDENTIAL_NAME,
        credentialProjectId: PROJECT_ID,
        sharedByDisplayName: DISPLAY_NAME,
      },
    }
  }

  /** Routes the lookup by token: `dead-*` resolve to a terminal share of ORG_ID, `other-*` to an
   *  active share of another org, anything else to an active share of ORG_ID. */
  function routeLookups(terminalStatus: (typeof TERMINAL_STATUSES)[number]) {
    findExternalShareByTokenHash.mockImplementation(async (token: string) => {
      if (token.startsWith('dead-')) {
        return lookupResult({ ...SHARE_ROW, status: terminalStatus })
      }
      if (token.startsWith('other-')) return lookupResult({ ...SHARE_ROW, orgId: OTHER_ORG_ID })
      return lookupResult(SHARE_ROW)
    })
    revealExternalShare.mockImplementation(async (token: string) => {
      if (token.startsWith('dead-')) {
        return { status: terminalStatus === 'viewed' ? 'already_viewed' : terminalStatus }
      }
      return {
        status: 'ok',
        share: token.startsWith('other-') ? { ...SHARE_ROW, orgId: OTHER_ORG_ID } : SHARE_ROW,
        value: BURST_VALUE,
        valueFormat: 'scalar',
        fieldKey: null,
      }
    })
  }

  const advanceFloor = async () => {
    await vi.advanceTimersByTimeAsync(FLOOR_MS)
  }

  describe.each(TERMINAL_STATUSES)('a %s token', (terminalStatus) => {
    it(`redeemed ${BURST}x through findShareByToken never limits an active share of the same org, and another org is unaffected`, async () => {
      routeLookups(terminalStatus)
      const host = buildCredentialSharingHost(
        MANIFEST,
        {},
        { orgRateLimits: { findShareByToken: 2, revealShare: 2 } }
      )

      const burst = await redeemInBatches(BURST, () => host.findShareByToken(DEAD_TOKEN), {
        afterBatchStarted: advanceFloor,
      })
      expect(firstRejection(burst)).toBeUndefined()
      expect(burst).toHaveLength(BURST)
      for (const settled of burst) {
        expect(settled).toMatchObject({
          status: 'fulfilled',
          value: { status: 'ok', share: { status: terminalStatus } },
        })
      }

      // The org's active share still resolves, up to the budget active traffic alone is entitled
      // to, and another org's active share is unaffected.
      const active = await redeemInBatches(2, () => host.findShareByToken(ACTIVE_TOKEN))
      expect(firstRejection(active)).toBeUndefined()
      await expect(host.findShareByToken(OTHER_ORG_TOKEN)).resolves.toMatchObject({ status: 'ok' })
    })

    it(`redeemed ${BURST}x through revealShare never limits an active share of the same org, and another org is unaffected`, async () => {
      routeLookups(terminalStatus)
      const host = buildCredentialSharingHost(
        MANIFEST,
        {},
        { orgRateLimits: { findShareByToken: 2, revealShare: 2 } }
      )

      const burst = await redeemInBatches(BURST, () => host.revealShare(DEAD_TOKEN), {
        afterBatchStarted: advanceFloor,
      })
      expect(firstRejection(burst)).toBeUndefined()
      const expected = terminalStatus === 'viewed' ? 'already_viewed' : terminalStatus
      for (const settled of burst) {
        expect(settled).toEqual({ status: 'fulfilled', value: { status: expected } })
      }

      const active = await redeemInBatches(2, () => host.revealShare(ACTIVE_TOKEN))
      expect(firstRejection(active)).toBeUndefined()
      await expect(host.revealShare(OTHER_ORG_TOKEN)).resolves.toMatchObject({ status: 'ok' })
    })
  })

  it('a genuine flood on ACTIVE shares is still limited, with the same event, fields and audit outcome', async () => {
    routeLookups('revoked')
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }
    const host = buildCredentialSharingHost(MANIFEST, logger, {
      orgRateLimits: { findShareByToken: 3 },
    })

    const burst = await redeemInBatches(3, () => host.findShareByToken(ACTIVE_TOKEN))
    expect(firstRejection(burst)).toBeUndefined()
    logger.info.mockClear()

    const limited = host.findShareByToken(ACTIVE_TOKEN)
    const assertion = expect(limited).rejects.toBeInstanceOf(CredentialSharingOrgRateLimitedError)
    await advanceFloor()
    await assertion

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: OperationalEvent.CREDENTIAL_SHARING_HOST_ORG_RATE_LIMITED,
        extensionName: MANIFEST.name,
        organizationId: ORG_ID,
      }),
      expect.any(String)
    )
    const audits = logger.info.mock.calls.filter(
      ([fields]) => typeof fields === 'object' && fields !== null && 'outcome' in fields
    )
    expect(audits).toHaveLength(1)
    expect(audits[0]?.[0]).toEqual(
      expect.objectContaining({
        organizationId: ORG_ID,
        method: 'findShareByToken',
        outcome: 'org-rate-limited',
      })
    )
  })

  it('the revealShare flood on ACTIVE shares is still limited per org', async () => {
    routeLookups('revoked')
    const host = buildCredentialSharingHost(MANIFEST, {}, { orgRateLimits: { revealShare: 2 } })
    const burst = await redeemInBatches(2, () => host.revealShare(ACTIVE_TOKEN))
    expect(firstRejection(burst)).toBeUndefined()

    const limited = host.revealShare(ACTIVE_TOKEN)
    const assertion = expect(limited).rejects.toBeInstanceOf(CredentialSharingOrgRateLimitedError)
    await advanceFloor()
    await assertion
    // Another org is not affected by the exhausted org.
    await expect(host.revealShare(OTHER_ORG_TOKEN)).resolves.toMatchObject({ status: 'ok' })
  })

  it('mixed traffic: terminal calls between active calls do not move the point where the active limit trips', async () => {
    routeLookups('revoked')
    const host = buildCredentialSharingHost(
      MANIFEST,
      {},
      { orgRateLimits: { findShareByToken: 3 } }
    )

    await host.findShareByToken(ACTIVE_TOKEN)
    const deadOne = host.findShareByToken(DEAD_TOKEN)
    await advanceFloor()
    await deadOne
    await host.findShareByToken(ACTIVE_TOKEN)
    const deadTwo = host.findShareByToken(DEAD_TOKEN)
    await advanceFloor()
    await deadTwo
    await host.findShareByToken(ACTIVE_TOKEN)

    // Three active calls used the whole budget of 3; the 4th ACTIVE call trips.
    const limited = host.findShareByToken(ACTIVE_TOKEN)
    const assertion = expect(limited).rejects.toBeInstanceOf(CredentialSharingOrgRateLimitedError)
    await advanceFloor()
    await assertion
    // A terminal call is still answered while the org is limited for active traffic.
    const dead = host.findShareByToken(DEAD_TOKEN)
    await advanceFloor()
    await expect(dead).resolves.toMatchObject({ status: 'ok', share: { status: 'revoked' } })
  })

  it('a terminal call is still held to the 65.4 miss floor (timing equalization not regressed)', async () => {
    routeLookups('revoked')
    const host = buildCredentialSharingHost(MANIFEST)
    let settled = false
    const call = host.findShareByToken(DEAD_TOKEN).then((value) => {
      settled = true
      return value
    })
    await vi.advanceTimersByTimeAsync(FLOOR_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(call).resolves.toMatchObject({ status: 'ok' })
  })
})
