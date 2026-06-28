import pino from 'pino'
import type { FastifyBaseLogger } from 'fastify'
import { SYSTEM_TRACE_ID } from '@project-vault/shared'
import type { Env } from '../config/env.js'
import { PINO_REDACT_PATHS } from './redact-paths.js'

export type LoggerConfig = ReturnType<typeof buildPinoOptions>
export type SerializedLogError = { message: string; name?: string; stack?: string }

function buildPinoOptions(
  env: Pick<Env, 'NODE_ENV' | 'LOG_LEVEL' | 'SERVICE_NAME'>,
  level: string
) {
  return {
    level,
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    messageKey: 'message',
    base: { service: env.SERVICE_NAME },
    redact: {
      paths: [...PINO_REDACT_PATHS],
      censor: '[REDACTED]',
    },
    formatters: {
      level(label: string) {
        return { level: label }
      },
    },
    mixin() {
      return { eventType: 'system.untyped' }
    },
  }
}

/**
 * Builds Fastify-compatible logger config. With no destination, returns a plain
 * options object — Fastify constructs its own pino instance against stdout
 * (synchronous; may block under log-driver backpressure). With a destination,
 * returns a real pino instance — used by tests to capture log lines, and by any
 * future production deployment wanting non-blocking transport (e.g.
 * pino.transport({ target: 'pino/file', options: { destination: 1 } })) without
 * refactoring this function's signature.
 */
export function createLoggerConfig(
  env: Pick<Env, 'NODE_ENV' | 'LOG_LEVEL' | 'SERVICE_NAME'>
): LoggerConfig
export function createLoggerConfig(
  env: Pick<Env, 'NODE_ENV' | 'LOG_LEVEL' | 'SERVICE_NAME'>,
  destination: pino.DestinationStream
): pino.Logger
export function createLoggerConfig(
  env: Pick<Env, 'NODE_ENV' | 'LOG_LEVEL' | 'SERVICE_NAME'>,
  destination?: pino.DestinationStream
): pino.Logger | LoggerConfig {
  // NODE_ENV=test forces silent on the default stdout pipeline so test output stays
  // clean. An explicit destination signals the caller wants to capture log lines
  // (e.g. structured-log-schema.test.ts) — honor env.LOG_LEVEL in that case instead.
  const level = !destination && env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL
  const config = buildPinoOptions(env, level)
  return destination ? pino(config, destination) : config
}

/**
 * Emits a non-request-scoped structured log (startup, shutdown, jobs). Always
 * injects SYSTEM_TRACE_ID — callers cannot override it. Request-scoped code must
 * use request.log (or request.log.child()) directly, never this function, so a
 * real trace ID is never masked by the sentinel value.
 */
export function operationalLog(
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>,
  level: 'info' | 'warn' | 'error',
  eventType: string,
  message: string,
  fields?: Record<string, unknown>
): void {
  const payload = { ...fields, eventType, traceId: SYSTEM_TRACE_ID }
  switch (level) {
    case 'info':
      logger.info(payload, message)
      break
    case 'warn':
      logger.warn(payload, message)
      break
    case 'error':
      logger.error(payload, message)
      break
  }
}

export function serializeLogError(err: unknown): SerializedLogError {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    }
  }
  try {
    return { message: String(err) }
  } catch {
    return { message: 'Unable to serialize thrown value' }
  }
}
