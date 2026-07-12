import { describe, expect, it, vi } from 'vitest'
import { deletedCountFromResult, runPruneJob } from './prune-utils.js'

describe('deletedCountFromResult', () => {
  it('returns the array length for an array result (Drizzle .returning())', () => {
    expect(deletedCountFromResult([{ id: 1 }, { id: 2 }, { id: 3 }])).toBe(3)
    expect(deletedCountFromResult([])).toBe(0)
  })

  it('returns rowCount for a rowCount-shaped result', () => {
    expect(deletedCountFromResult({ rowCount: 5 })).toBe(5)
  })

  it('returns 0 when rowCount is missing/undefined on an object result', () => {
    expect(deletedCountFromResult({ rowCount: undefined })).toBe(0)
  })

  it('returns 0 for null, primitives, or any other unrecognized shape', () => {
    expect(deletedCountFromResult(null)).toBe(0)
    expect(deletedCountFromResult(undefined)).toBe(0)
    expect(deletedCountFromResult(42)).toBe(0)
    expect(deletedCountFromResult('not a result')).toBe(0)
    expect(deletedCountFromResult({ noRowCountField: true })).toBe(0)
  })
})

describe('runPruneJob', () => {
  function fakeLogger() {
    return { info: vi.fn(), error: vi.fn() }
  }

  it('logs job.completed with the deleted count on success', async () => {
    const logger = fakeLogger()
    await runPruneJob('test/job', async () => [{ id: 1 }, { id: 2 }], logger)

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'job.completed', jobName: 'test/job', deletedCount: 2 })
    )
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('logs job.failed and rethrows when deleteExpiredRows throws', async () => {
    const logger = fakeLogger()
    const boom = new Error('boom')

    await expect(
      runPruneJob(
        'test/job',
        async () => {
          throw boom
        },
        logger
      )
    ).rejects.toThrow('boom')

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'job.failed', jobName: 'test/job', err: boom })
    )
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('uses the default worker logger (writing to stdout/stderr) when none is provided', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await runPruneJob('test/job', async () => [{ id: 1 }])
      expect(stdoutSpy).toHaveBeenCalled()
      const logged = JSON.parse(stdoutSpy.mock.calls[0]?.[0] as string) as { eventType: string }
      expect(logged.eventType).toBe('job.completed')
    } finally {
      stdoutSpy.mockRestore()
    }
  })
})
