import { describe, expect, it, vi } from 'vitest'
import { OperationalEvent, SYSTEM_TRACE_ID } from '@project-vault/shared'
import { withJobLogging } from './job-logging.js'

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

describe('withJobLogging', () => {
  it('logs job.started and job.completed around a successful worker', async () => {
    const logger = createLogger()
    const worker = vi.fn().mockResolvedValue('done')

    await expect(withJobLogging(logger, 'test-job', 'job-1', worker)).resolves.toBe('done')

    expect(logger.info).toHaveBeenCalledTimes(2)
    expect(logger.info).toHaveBeenNthCalledWith(
      1,
      {
        eventType: OperationalEvent.JOB_STARTED,
        traceId: SYSTEM_TRACE_ID,
        jobName: 'test-job',
        jobId: 'job-1',
      },
      'job started'
    )
    expect(logger.info).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        eventType: OperationalEvent.JOB_COMPLETED,
        traceId: SYSTEM_TRACE_ID,
        jobName: 'test-job',
        jobId: 'job-1',
        durationMs: expect.any(Number),
      }),
      'job completed'
    )
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('logs job.failed and rethrows the original non-Error throw value', async () => {
    const logger = createLogger()
    const thrown = 'string error'

    await expect(
      withJobLogging(logger, 'test-job', 'job-1', async () => {
        throw thrown
      })
    ).rejects.toBe(thrown)

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: OperationalEvent.JOB_FAILED,
        traceId: SYSTEM_TRACE_ID,
        jobName: 'test-job',
        jobId: 'job-1',
        durationMs: expect.any(Number),
        err: { message: thrown },
      }),
      'job failed'
    )
  })
})
