import type { FastifyBaseLogger } from 'fastify'
import { OperationalEvent } from '@project-vault/shared'
import { operationalLog, serializeLogError } from './logger.js'

export async function withJobLogging<T>(
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>,
  jobName: string,
  jobId: string,
  fn: () => Promise<T>
): Promise<T> {
  const start = Date.now()
  operationalLog(logger, 'info', OperationalEvent.JOB_STARTED, 'job started', { jobName, jobId })
  try {
    const result = await fn()
    operationalLog(logger, 'info', OperationalEvent.JOB_COMPLETED, 'job completed', {
      jobName,
      jobId,
      durationMs: Date.now() - start,
    })
    return result
  } catch (err) {
    operationalLog(logger, 'error', OperationalEvent.JOB_FAILED, 'job failed', {
      jobName,
      jobId,
      durationMs: Date.now() - start,
      err: serializeLogError(err),
    })
    throw err
  }
}
