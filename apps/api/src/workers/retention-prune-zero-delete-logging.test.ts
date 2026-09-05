import { describe, expect, it, vi } from 'vitest'

const executeMock = vi.fn(async () => [{ deleted: '0' }])

// Story 1.25 AC-4: see platform-audit-retention-prune.test.ts's identical comment — stubs the
// new expectedGapHash-capture `tx.select(...)` lookup to find no survivor row.
const selectMock = vi.fn(() => ({
  from: () => ({
    where: () => ({
      orderBy: () => ({
        limit: async () => [],
      }),
    }),
  }),
}))

vi.mock('@project-vault/db', () => ({
  withPlatformOperatorContext: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ execute: executeMock, select: selectMock }),
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
