import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const DB_MODULE = '@project-vault/db'

// eslint-disable-next-line no-secrets/no-secrets -- test fixture UUID, not a secret.
const OPERATOR_ID = '11111111-1111-1111-1111-111111111111'
// eslint-disable-next-line no-secrets/no-secrets -- test fixture UUID, not a secret.
const TARGET_ID = '22222222-2222-2222-2222-222222222222'
const MINTED_URL = 'http://localhost:5173/recovery/opaque-token-not-a-real-secret'
const TARGET_EMAIL = 'ops@example.test'

const {
  getNativeLoginPolicyState,
  createRecoveryToken,
  recoveryLinkUrl,
  writePlatformAuditEntryOrFailClosed,
  operationalLog,
  createApp,
} = vi.hoisted(() => ({
  getNativeLoginPolicyState: vi.fn(),
  createRecoveryToken: vi.fn(),
  recoveryLinkUrl: vi.fn(() => 'http://localhost:5173/recovery/opaque-token-not-a-real-secret'),
  writePlatformAuditEntryOrFailClosed: vi.fn(),
  operationalLog: vi.fn(),
  createApp: vi.fn(),
}))

vi.mock('../modules/auth/native-login-policy.js', () => ({ getNativeLoginPolicyState }))
vi.mock('../modules/auth/recovery.js', () => ({ createRecoveryToken, recoveryLinkUrl }))
vi.mock('../lib/audit-or-fail-closed.js', () => ({ writePlatformAuditEntryOrFailClosed }))
vi.mock('../lib/logger.js', () => ({ operationalLog }))
vi.mock('../app.js', () => ({ createApp }))

/** A drizzle `.select().from().where().limit()` chain that resolves the next queued row-set on
 * each call — the module under test issues exactly two such lookups per happy-path invocation
 * (the platform operator, then the target user), in that order. */
function makeFakeTx(resultsQueue: { id: string }[][]) {
  let call = 0
  const select = vi.fn(() => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(resultsQueue[call++] ?? []),
      }),
    }),
  }))
  return { select }
}

async function mockGetDb(resultsQueue: { id: string }[][]) {
  const tx = makeFakeTx(resultsQueue)
  const transaction = vi.fn((cb: (tx: unknown) => unknown) => cb(tx))
  vi.doMock(DB_MODULE, () => ({ getDb: () => ({ transaction }) }))
  return { tx, transaction }
}

function allowedPolicy(overrides: Partial<Record<string, boolean>> = {}) {
  return {
    breakGlassActive: true,
    replacementDeclared: true,
    replacementProven: true,
    replacementConfirmedOverride: false,
    ...overrides,
  }
}

describe('evaluateBreakGlassGate', () => {
  it('refuses break_glass_off when the flag is not set, regardless of the other two clauses', async () => {
    const { evaluateBreakGlassGate } = await import('./operator-recovery-link.js')
    expect(evaluateBreakGlassGate(allowedPolicy({ breakGlassActive: false }))).toEqual({
      allowed: false,
      reason: 'break_glass_off',
    })
  })

  it('refuses replacement_not_declared when no extension declares replacement', async () => {
    const { evaluateBreakGlassGate } = await import('./operator-recovery-link.js')
    expect(evaluateBreakGlassGate(allowedPolicy({ replacementDeclared: false }))).toEqual({
      allowed: false,
      reason: 'replacement_not_declared',
    })
  })

  it('refuses not_excluded when neither replacementProven nor the confirmed override is set', async () => {
    const { evaluateBreakGlassGate } = await import('./operator-recovery-link.js')
    expect(
      evaluateBreakGlassGate(
        allowedPolicy({ replacementProven: false, replacementConfirmedOverride: false })
      )
    ).toEqual({ allowed: false, reason: 'not_excluded' })
  })

  it('allows via replacementConfirmedOverride even when replacementProven is false', async () => {
    const { evaluateBreakGlassGate } = await import('./operator-recovery-link.js')
    expect(
      evaluateBreakGlassGate(
        allowedPolicy({ replacementProven: false, replacementConfirmedOverride: true })
      )
    ).toEqual({ allowed: true })
  })

  it('allows when all three clauses hold', async () => {
    const { evaluateBreakGlassGate } = await import('./operator-recovery-link.js')
    expect(evaluateBreakGlassGate(allowedPolicy())).toEqual({ allowed: true })
  })

  it('never allows on the strength of native login simply being enabled — the finding-N4 backdoor stays deleted', async () => {
    const { evaluateBreakGlassGate } = await import('./operator-recovery-link.js')
    // "native login enabled" alone means breakGlassActive is false on every ordinary deployment —
    // the old `OR native login already enabled` clause is not present anywhere in the function.
    expect(evaluateBreakGlassGate(allowedPolicy({ breakGlassActive: false }))).toEqual({
      allowed: false,
      reason: 'break_glass_off',
    })
  })
})

describe('runOperatorRecoveryLink', () => {
  beforeEach(() => {
    vi.resetModules()
    getNativeLoginPolicyState.mockReset().mockReturnValue(allowedPolicy())
    createRecoveryToken
      .mockReset()
      .mockResolvedValue({ opaqueToken: 'opaque', expiresAt: new Date() })
    recoveryLinkUrl.mockReset().mockReturnValue(MINTED_URL)
    writePlatformAuditEntryOrFailClosed.mockReset().mockResolvedValue(undefined)
    operationalLog.mockReset()
  })

  it('mints a link and writes the audit row before the token, with no PII/secret leaking into the payload', async () => {
    await mockGetDb([[{ id: OPERATOR_ID }], [{ id: TARGET_ID }]])
    const { runOperatorRecoveryLink } = await import('./operator-recovery-link.js')

    const result = await runOperatorRecoveryLink(TARGET_EMAIL)

    expect(result).toEqual({ outcome: 'minted', url: MINTED_URL })
    expect(createRecoveryToken).toHaveBeenCalledWith(expect.anything(), {
      userId: TARGET_ID,
      initiatedBy: 'admin',
    })
    // AC-8a item 5: no initiatorUserId/initiatorOrgId — the unambiguous break-glass signature.
    const tokenCallArgs = createRecoveryToken.mock.calls[0]?.[1]
    expect(tokenCallArgs).not.toHaveProperty('initiatorUserId')
    expect(tokenCallArgs).not.toHaveProperty('initiatorOrgId')

    expect(writePlatformAuditEntryOrFailClosed).toHaveBeenCalledTimes(1)
    const auditCallArgs = writePlatformAuditEntryOrFailClosed.mock.calls[0]?.[1]
    expect(auditCallArgs.operatorId).toBe(OPERATOR_ID)
    expect(auditCallArgs.targetUserId).toBe(TARGET_ID)
    expect(auditCallArgs.payload).toMatchObject({ targetUserId: TARGET_ID, outcome: 'minted' })
    expect(auditCallArgs.payload).toHaveProperty('invokingOsUser')
    expect(auditCallArgs.payload).toHaveProperty('hostname')
    expect(auditCallArgs.payload).toHaveProperty('pid')
    // Never the email, the token, the URL, or a resulting hash.
    const payloadValues = JSON.stringify(auditCallArgs.payload)
    expect(payloadValues).not.toContain(TARGET_EMAIL)
    expect(payloadValues).not.toContain('opaque')
    expect(payloadValues).not.toContain(MINTED_URL)

    // Statement order: the audit write is called strictly before the token mint.
    const auditOrder = writePlatformAuditEntryOrFailClosed.mock.invocationCallOrder[0]
    const mintOrder = createRecoveryToken.mock.invocationCallOrder[0]
    expect(auditOrder).toBeLessThan(mintOrder as number)
  })

  it('refuses and mints nothing when the gate is not satisfied, still auditing the refusal', async () => {
    getNativeLoginPolicyState.mockReturnValue(allowedPolicy({ breakGlassActive: false }))
    await mockGetDb([[{ id: OPERATOR_ID }]])
    const { runOperatorRecoveryLink } = await import('./operator-recovery-link.js')

    const result = await runOperatorRecoveryLink(TARGET_EMAIL)

    expect(result).toEqual({ outcome: 'refused', reason: 'break_glass_off' })
    expect(createRecoveryToken).not.toHaveBeenCalled()
    expect(writePlatformAuditEntryOrFailClosed).toHaveBeenCalledTimes(1)
    const auditCallArgs = writePlatformAuditEntryOrFailClosed.mock.calls[0]?.[1]
    expect(auditCallArgs.targetUserId).toBeUndefined()
    expect(auditCallArgs.payload).toMatchObject({
      outcome: 'refused',
      refusalReason: 'break_glass_off',
    })
  })

  it('refuses with user_not_found and mints nothing when the gate passes but no such user exists — never creates a user', async () => {
    await mockGetDb([[{ id: OPERATOR_ID }], []])
    const { runOperatorRecoveryLink } = await import('./operator-recovery-link.js')

    const result = await runOperatorRecoveryLink('nobody@example.test')

    expect(result).toEqual({ outcome: 'refused', reason: 'user_not_found' })
    expect(createRecoveryToken).not.toHaveBeenCalled()
    const auditCallArgs = writePlatformAuditEntryOrFailClosed.mock.calls[0]?.[1]
    expect(auditCallArgs.payload.refusalReason).toBe('user_not_found')
  })

  it('is fail-closed: an audit-write failure propagates and the token is never minted', async () => {
    writePlatformAuditEntryOrFailClosed.mockReset().mockRejectedValue(new Error('audit store down'))
    await mockGetDb([[{ id: OPERATOR_ID }], [{ id: TARGET_ID }]])
    const { runOperatorRecoveryLink } = await import('./operator-recovery-link.js')

    await expect(runOperatorRecoveryLink(TARGET_EMAIL)).rejects.toThrow('audit store down')
    expect(createRecoveryToken).not.toHaveBeenCalled()
  })

  it('throws before touching a token if no platform operator row exists (corrupted-instance guard)', async () => {
    await mockGetDb([[]])
    const { runOperatorRecoveryLink } = await import('./operator-recovery-link.js')

    await expect(runOperatorRecoveryLink(TARGET_EMAIL)).rejects.toThrow(
      /no platform operator row found/
    )
    expect(writePlatformAuditEntryOrFailClosed).not.toHaveBeenCalled()
    expect(createRecoveryToken).not.toHaveBeenCalled()
  })
})

describe('main() — TTY / stdout-capture guard and usage', () => {
  const originalIsTTY = process.stdout.isTTY
  const originalExitCode = process.exitCode

  beforeEach(() => {
    vi.resetModules()
    getNativeLoginPolicyState.mockReset().mockReturnValue(allowedPolicy())
    createRecoveryToken
      .mockReset()
      .mockResolvedValue({ opaqueToken: 'opaque', expiresAt: new Date() })
    recoveryLinkUrl.mockReset().mockReturnValue(MINTED_URL)
    writePlatformAuditEntryOrFailClosed.mockReset().mockResolvedValue(undefined)
    operationalLog.mockReset()
    createApp.mockReset()
    process.exitCode = undefined
  })

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true })
    process.exitCode = originalExitCode
  })

  it('refuses a non-TTY stdout without --yes-print-to-pipe, and never boots the app', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
    const { main } = await import('./operator-recovery-link.js')

    await main(['someone@example.test'])

    expect(process.exitCode).toBe(1)
    expect(createApp).not.toHaveBeenCalled()
  })

  it('proceeds on a non-TTY stdout when --yes-print-to-pipe is passed', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
    const close = vi.fn().mockResolvedValue(undefined)
    createApp.mockResolvedValue({ close })
    await mockGetDb([[{ id: OPERATOR_ID }], [{ id: TARGET_ID }]])
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const { main } = await import('./operator-recovery-link.js')
    await main([TARGET_EMAIL, '--yes-print-to-pipe'])

    expect(createApp).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(writeSpy).toHaveBeenCalledWith(`${MINTED_URL}\n`)
    writeSpy.mockRestore()
  })

  it('throws a usage error when no email argument is supplied', async () => {
    const { main } = await import('./operator-recovery-link.js')
    await expect(main([])).rejects.toThrow(/Usage: operator:recovery-link/)
  })
})
