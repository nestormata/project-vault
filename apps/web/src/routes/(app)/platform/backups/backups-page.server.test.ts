import { describe, expect, it, vi, beforeEach } from 'vitest'

const platformOperatorGateMock = vi.hoisted(() => vi.fn())
const listBackupsMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/server/require-platform-operator.js', () => ({
  platformOperatorGate: platformOperatorGateMock,
}))

vi.mock('$lib/api/platform.js', () => ({
  listBackups: listBackupsMock,
}))

import { load } from './+page.server.js'

const platformUser = {
  userId: '00000000-0000-4000-8000-000000000001',
  orgId: '00000000-0000-4000-8000-000000000002',
  orgName: 'Test Org',
  sessionId: '00000000-0000-4000-8000-000000000003',
  orgRole: 'owner' as const,
  isPlatformOperator: true,
  mfaEnrolled: false,
  mfaEnrolledAt: null,
  remainingRecoveryCodesCount: null,
  mfaStatus: {
    enrollmentRequired: false,
    gracePeriodActive: false,
    gracePeriodExpiresAt: null,
    gracePeriodDaysRemaining: null,
    bannerMessage: null,
  },
}

function makeEvent() {
  return { fetch: vi.fn(), locals: { user: platformUser } } as unknown as Parameters<typeof load>[0]
}

const SAMPLE_BACKUPS = {
  items: [
    {
      filename: 'backup_20260701T030000Z_org-abc.vault',
      timestamp: '2026-07-01T03:00:00.000Z',
      sizeBytes: 2400000000,
      keyVersion: 1,
      verified: 'valid' as const,
      status: 'succeeded' as const,
      errorMessage: null,
    },
  ],
}

describe('/platform/backups +page.server.ts', () => {
  beforeEach(() => {
    platformOperatorGateMock.mockReset()
    listBackupsMock.mockReset()
  })

  it('AC-A3: returns allowed=false for non-platform-operator without fetching backups', async () => {
    platformOperatorGateMock.mockReturnValue({ allowed: false })

    const result = await load(makeEvent())

    expect(result.allowed).toBe(false)
    expect(listBackupsMock).not.toHaveBeenCalled()
  })

  it('AC-C1: returns allowed=true with backup items for a platform operator', async () => {
    platformOperatorGateMock.mockReturnValue({ allowed: true, user: platformUser })
    listBackupsMock.mockResolvedValue(SAMPLE_BACKUPS)

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.backups).toHaveLength(1)
      expect(result.backups[0].filename).toBe('backup_20260701T030000Z_org-abc.vault')
      expect(result.backups[0].status).toBe('succeeded')
      expect(result.errorMessage).toBeNull()
    }
  })

  it('AC-C1 edge: returns empty backups array on a fresh instance', async () => {
    platformOperatorGateMock.mockReturnValue({ allowed: true, user: platformUser })
    listBackupsMock.mockResolvedValue({ items: [] })

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.backups).toHaveLength(0)
      expect(result.errorMessage).toBeNull()
    }
  })

  it('surfaces a friendly errorMessage on API failure without crashing', async () => {
    platformOperatorGateMock.mockReturnValue({ allowed: true, user: platformUser })
    listBackupsMock.mockRejectedValue(new Error('Network error'))

    const result = await load(makeEvent())

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.backups).toHaveLength(0)
      expect(result.errorMessage).toBeTruthy()
    }
  })
})
