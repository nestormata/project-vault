import { beforeEach, describe, expect, it, vi } from 'vitest'

const insertValues = vi.fn()
const tx = {
  select: vi.fn(() => ({
    from: () => ({
      limit: async () => [{ auditKeyVersion: 7 }],
    }),
  })),
  insert: vi.fn(() => ({ values: insertValues })),
}
const db = {
  select: vi.fn(),
  transaction: vi.fn(async (fn: (txArg: typeof tx) => Promise<unknown>) => fn(tx)),
}

vi.mock('@project-vault/db', () => ({
  getDb: () => db,
  withOrg: vi.fn(),
}))

vi.mock('../vault/key-service.js', () => ({
  getAuditKey: () => Buffer.alloc(32, 1),
}))

vi.mock('./password.js', () => ({
  hashUserPassword: vi.fn(),
  verifyUserPassword: vi.fn(async () => false),
}))

function userLookupRows(rows: unknown[]) {
  return {
    from: () => ({
      leftJoin: () => ({
        where: async () => rows,
      }),
    }),
  }
}

function orgLookupRows(rows: unknown[] = []) {
  return {
    from: async () => rows,
  }
}

function loginRows(rows: unknown[]) {
  db.select.mockReturnValueOnce(userLookupRows(rows))
  if (rows.length > 0) {
    db.select.mockReturnValueOnce(orgLookupRows())
  }
}

describe('failed login platform security events', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    insertValues.mockResolvedValue(undefined)
  })

  it('writes a platform event for unknown login subjects', async () => {
    loginRows([])
    const { loginUser } = await import('./service.js')

    await expect(
      loginUser(
        { email: 'missing@example.com', password: 'incorrect-password' },
        { ipAddress: '203.0.113.10', userAgent: 'vitest' }
      )
    ).rejects.toMatchObject({ code: 'invalid_credentials' })

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'LOGIN_FAILED',
        emailDomain: 'example.com',
        payload: { reason: 'unknown_subject' },
        ipAddress: '203.0.113.10',
        userAgent: 'vitest',
        keyVersion: 7,
        subjectHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        hmac: expect.stringMatching(/^[0-9a-f]{64}$/),
      })
    )
  })

  it('writes a platform event for orphan users without an org membership', async () => {
    loginRows([
      {
        id: 'user-id',
        email: 'orphan@example.com',
        passwordHash: 'hash',
        orgId: null,
        membershipStatus: null,
        identityTokenId: null,
      },
    ])
    const { loginUser } = await import('./service.js')

    await expect(
      loginUser({ email: 'orphan@example.com', password: 'incorrect-password' })
    ).rejects.toMatchObject({ code: 'invalid_credentials' })

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'LOGIN_FAILED',
        emailDomain: 'example.com',
        payload: { reason: 'orphan_user' },
        subjectHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      })
    )
  })
})
