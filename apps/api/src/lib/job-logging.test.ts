import { describe, expect, it, vi } from 'vitest'
import { OperationalEvent, SYSTEM_TRACE_ID } from '@project-vault/shared'
import {
  createLogCaptureStream,
  flushCapturedLogger,
  parseCapturedLogLines,
} from '../__tests__/helpers/capture-logs.js'
import type { Env } from '../config/env.js'
import { withJobLogging } from './job-logging.js'
import { createLoggerConfig, EMAIL_REDACTION_PLACEHOLDER } from './logger.js'

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

async function expectFailedJobLog(
  thrown: unknown,
  expectedError: { message: string }
): Promise<void> {
  const logger = createLogger()

  await expect(
    withJobLogging(logger, 'test-job', 'job-1', async () => Promise.reject(thrown))
  ).rejects.toBe(thrown)

  expect(logger.error).toHaveBeenCalledWith(
    expect.objectContaining({
      eventType: OperationalEvent.JOB_FAILED,
      traceId: SYSTEM_TRACE_ID,
      jobName: 'test-job',
      jobId: 'job-1',
      durationMs: expect.any(Number),
      err: expectedError,
    }),
    'job failed'
  )
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
    const thrown = 'string error'

    await expectFailedJobLog(thrown, { message: thrown })
  })

  it('logs job.failed and rethrows the original value when error serialization fails', async () => {
    const thrown = {
      toString() {
        throw new Error('toString failed')
      },
    }

    await expectFailedJobLog(thrown, { message: 'Unable to serialize thrown value' })
  })

  describe('recipient address redaction (70-4)', () => {
    const rejected = () =>
      Object.assign(new Error('Recipient address rejected: <jordan@example.com>'), {
        code: 'EENVELOPE',
        rejected: ['jordan@example.com'],
        response: '550 5.1.1 <jordan@example.com>: Recipient address rejected',
        command: 'RCPT TO',
      })
    const socketError = () => {
      const err = Object.assign(new Error('Connection closed unexpectedly'), { code: 'ESOCKET' })
      err.stack = `Error: Connection closed unexpectedly\n    at SMTPConnection (RCPT TO:<jordan@example.com>)`
      return err
    }

    it.each([
      ['EENVELOPE', rejected],
      ['ESOCKET', socketError],
    ])(
      'logs no address for a nodemailer-shaped %s error and rethrows the original',
      async (_c, build) => {
        const logger = createLogger()
        const thrown = build()
        const originalMessage = thrown.message

        await expect(
          withJobLogging(logger, 'notification/deliver', 'job-1', async () =>
            Promise.reject(thrown)
          )
        ).rejects.toBe(thrown)

        expect(thrown.message).toBe(originalMessage)
        expect(logger.error).toHaveBeenCalledTimes(1)
        const logged = JSON.stringify(logger.error.mock.calls[0])
        expect(logged).not.toContain('jordan')
        expect(logged).toContain(EMAIL_REDACTION_PLACEHOLDER)
      }
    )

    it('writes an address-free final line through a real pino instance', async () => {
      const { stream, lines } = createLogCaptureStream()
      const logger = createLoggerConfig(
        { NODE_ENV: 'development', LOG_LEVEL: 'info', SERVICE_NAME: 'api' } as Pick<
          Env,
          'NODE_ENV' | 'LOG_LEVEL' | 'SERVICE_NAME'
        >,
        stream
      )
      const thrown = rejected()

      await expect(
        withJobLogging(logger, 'notification/deliver', 'job-1', async () => Promise.reject(thrown))
      ).rejects.toBe(thrown)
      await flushCapturedLogger(logger)

      const raw = lines.join('')
      expect(raw).not.toContain('jordan')
      const failed = parseCapturedLogLines(lines).filter((l) => l.message === 'job failed')
      expect(failed).toHaveLength(1)
      expect(raw).toContain(EMAIL_REDACTION_PLACEHOLDER)
    })
  })
})
