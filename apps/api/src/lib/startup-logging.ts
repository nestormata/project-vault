import pino from 'pino'
import type { FastifyBaseLogger } from 'fastify'
import { OperationalEvent } from '@project-vault/shared'
import type { Env } from '../config/env.js'
import { createLoggerConfig, operationalLog, serializeLogError } from './logger.js'

type FlushableLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'> & {
  flush?: () => void | Promise<void>
}

export function createStartupLogger(
  env: Pick<Env, 'NODE_ENV' | 'LOG_LEVEL' | 'SERVICE_NAME'>
): FlushableLogger {
  return pino(createLoggerConfig(env))
}

export async function flushLogger(logger: FlushableLogger): Promise<void> {
  await logger.flush?.()
}

export async function logStartupFailure(logger: FlushableLogger, err: unknown): Promise<void> {
  operationalLog(logger, 'error', OperationalEvent.STARTUP_FAILED, 'API startup failed', {
    err: serializeLogError(err),
  })
  await flushLogger(logger)
}
