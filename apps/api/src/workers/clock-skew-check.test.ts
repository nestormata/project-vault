import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OperationalEvent } from '@project-vault/shared'

const executeMock = vi.fn()

vi.mock('@project-vault/db', () => ({
  getDb: () => ({ execute: executeMock }),
}))

vi.mock('../config/env.js', () => ({
  env: { VAULT_HANDOFF_CLOCK_SKEW_WARN_MS: 20000 },
}))

describe('Story 30.1 (DW-129) AC3: runClockSkewCheck', () => {
  let dateNowSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    executeMock.mockReset()
    const { __resetClockSkewDiagnosticsForTests } = await import('./clock-skew-check.js')
    __resetClockSkewDiagnosticsForTests()
  })

  afterEach(() => {
    dateNowSpy?.mockRestore()
  })

  it('AC8: normal drift below threshold logs CLOCK_SKEW_MEASURED at info and sets status "ok"', async () => {
    dateNowSpy = vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(1100)
    // requestStart=1000, requestEnd=1100, roundTripEstimate=50; dbNow=1050 => drift=0
    executeMock.mockResolvedValueOnce([{ now: new Date(1050) }])
    const { runClockSkewCheck, getClockSkewDiagnostics } = await import('./clock-skew-check.js')
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await runClockSkewCheck(logger)

    expect(logger.info).toHaveBeenCalledTimes(1)
    expect(logger.info.mock.calls[0]?.[0]).toMatchObject({
      eventType: OperationalEvent.CLOCK_SKEW_MEASURED,
      status: 'ok',
    })
    expect(logger.warn).not.toHaveBeenCalled()
    const diagnostics = getClockSkewDiagnostics()
    expect(diagnostics.status).toBe('ok')
    expect(diagnostics.lastMeasuredMs).toBe(0)
    expect(diagnostics.warnThresholdMs).toBe(20000)
    expect(diagnostics.measuredAt).not.toBeNull()
  })

  it('AC9: drift at/above threshold logs warn and flips diagnostics status to "warn"', async () => {
    dateNowSpy = vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(1100)
    // requestStart=1000, requestEnd=1100, roundTripEstimate=50; dbNow=1100-50-30000 => drift=30000
    executeMock.mockResolvedValueOnce([{ now: new Date(1100 - 50 - 30000) }])
    const { runClockSkewCheck, getClockSkewDiagnostics } = await import('./clock-skew-check.js')
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await runClockSkewCheck(logger)

    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({
      eventType: OperationalEvent.CLOCK_SKEW_MEASURED,
      status: 'warn',
      driftMs: 30000,
    })
    expect(logger.info).not.toHaveBeenCalled()
    const diagnostics = getClockSkewDiagnostics()
    expect(diagnostics.status).toBe('warn')
    expect(diagnostics.lastMeasuredMs).toBe(30000)
  })

  it('AC10: a DB failure logs CLOCK_SKEW_CHECK_FAILED at warn, never crashes, and leaves the previous diagnostics value in place', async () => {
    dateNowSpy = vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(1100)
    executeMock.mockResolvedValueOnce([{ now: new Date(1050) }])
    const { runClockSkewCheck, getClockSkewDiagnostics } = await import('./clock-skew-check.js')
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    // First: establish a known-good baseline diagnostics value.
    await runClockSkewCheck(logger)
    const baseline = getClockSkewDiagnostics()
    expect(baseline.status).toBe('ok')

    // Second: DB round-trip fails.
    logger.info.mockClear()
    logger.warn.mockClear()
    executeMock.mockRejectedValueOnce(new Error('connection pool exhausted'))

    await expect(runClockSkewCheck(logger)).resolves.toBeUndefined()

    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({
      eventType: OperationalEvent.CLOCK_SKEW_CHECK_FAILED,
    })
    expect(logger.info).not.toHaveBeenCalled()
    // AC10: previous diagnostics value is untouched, never reset to a false "ok".
    expect(getClockSkewDiagnostics()).toEqual(baseline)
  })

  it('never throws when called without a logger', async () => {
    executeMock.mockRejectedValueOnce(new Error('unreachable'))
    const { runClockSkewCheck } = await import('./clock-skew-check.js')
    await expect(runClockSkewCheck()).resolves.toBeUndefined()
  })

  it('AC9: is "unknown" before the first measurement completes', async () => {
    const { getClockSkewDiagnostics } = await import('./clock-skew-check.js')
    expect(getClockSkewDiagnostics().status).toBe('unknown')
    expect(getClockSkewDiagnostics().lastMeasuredMs).toBeNull()
  })
})
