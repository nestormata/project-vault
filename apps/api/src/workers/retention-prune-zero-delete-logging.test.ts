import { describe, expect, it, vi } from 'vitest'

const executeMock = vi.fn(async () => [{ deleted: '0' }])

vi.mock('@project-vault/db', () => ({
  withPlatformOperatorContext: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ execute: executeMock }),
}))

vi.mock('../config/env.js', () => ({
  env: { PLATFORM_AUDIT_RETENTION_DAYS: 365 },
}))

describe('Story 24.5a retention completion logging', () => {
  it('logs a completed platform purge even when it deletes zero rows', async () => {
    const { prunePlatformAuditEvents } = await import('./platform-audit-retention-prune.js')
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await prunePlatformAuditEvents(logger)

    expect(logger.info).toHaveBeenCalledTimes(1)
    expect(logger.info.mock.calls[0]?.[0]).toMatchObject({ deleted: 0 })
  })
})
