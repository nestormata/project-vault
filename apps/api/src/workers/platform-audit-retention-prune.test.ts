import { describe, it, expect, vi } from 'vitest'

const executeMock = vi.fn(async () => [{ deleted: '3' }])

vi.mock('@project-vault/db', () => ({
  withPlatformOperatorContext: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ execute: executeMock }),
}))

vi.mock('../config/env.js', () => ({
  env: { PLATFORM_AUDIT_RETENTION_DAYS: 365 },
}))

describe('Story 9.4 AC-17: prunePlatformAuditEvents worker', () => {
  it('calls purge_expired_platform_audit_entries with a cutoff based on PLATFORM_AUDIT_RETENTION_DAYS', async () => {
    const { prunePlatformAuditEvents } = await import('./platform-audit-retention-prune.js')
    await prunePlatformAuditEvents()
    expect(executeMock).toHaveBeenCalledTimes(1)
  })

  it('logs a summary only when rows were actually deleted', async () => {
    const { prunePlatformAuditEvents } = await import('./platform-audit-retention-prune.js')
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    await prunePlatformAuditEvents(logger)
    expect(logger.info).toHaveBeenCalledTimes(1)
  })

  it('does not log when zero rows were deleted', async () => {
    executeMock.mockResolvedValueOnce([{ deleted: '0' }])
    const { prunePlatformAuditEvents } = await import('./platform-audit-retention-prune.js')
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    await prunePlatformAuditEvents(logger)
    expect(logger.info).not.toHaveBeenCalled()
  })
})
