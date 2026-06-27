import type { FastifyBaseLogger } from 'fastify'
import { OperationalEvent } from '@project-vault/shared'
import { operationalLog } from './logger.js'

function serializeJobError(err: unknown): { message: string; name?: string; stack?: string } {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    }
  }
  return { message: String(err) }
}

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
      err: serializeJobError(err),
    })
    throw err
  }
}
