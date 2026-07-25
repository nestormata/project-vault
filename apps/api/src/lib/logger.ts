import pino from 'pino'
import type { FastifyBaseLogger } from 'fastify'
import { SYSTEM_TRACE_ID } from '@project-vault/shared'
import type { Env } from '../config/env.js'
import { PINO_REDACT_PATHS } from './redact-paths.js'

export type LoggerConfig = ReturnType<typeof buildPinoOptions>
export type SerializedLogError = { message: string; name?: string; stack?: string }
type LoggerEnv = Pick<Env, 'NODE_ENV' | 'LOG_LEVEL' | 'SERVICE_NAME'>

function buildPinoOptions(env: LoggerEnv, level: string) {
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
export function createLoggerConfig(env: LoggerEnv): LoggerConfig
export function createLoggerConfig(env: LoggerEnv, destination: pino.DestinationStream): pino.Logger
export function createLoggerConfig(
  env: LoggerEnv,
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
// `logger` is `Partial<...>` (not a plain `Pick`) rather than adding function overloads: an
// overloaded signature breaks every existing call site that derives its own logger parameter
// type via `Parameters<typeof operationalLog>[0]` (e.g. modules/backup/routes.ts's
// `reportBackupFailureAlert`) — `Parameters<T>` on an overloaded function resolves to only the
// last declared overload, silently narrowing those call sites to `Pick<FastifyBaseLogger,
// 'fatal'>`. A single `Partial<...>` signature keeps every pre-existing narrower
// `WorkerLogger`-style logger (info/warn/error, no `.fatal`) assignable unchanged, while still
// letting Story 14.2's fatal-equivalent boot-time logging (apps/api/src/extensions/loader.ts)
// pass `level: 'fatal'` with a logger that implements `.fatal`.
export function operationalLog(
  logger: Partial<Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'fatal'>>,
  level: 'info' | 'warn' | 'error' | 'fatal',
  eventType: string,
  message: string,
  fields?: Record<string, unknown>
): void {
  const payload = { ...fields, eventType, traceId: SYSTEM_TRACE_ID }
  switch (level) {
    case 'info':
      logger.info?.(payload, message)
      break
    case 'warn':
      logger.warn?.(payload, message)
      break
    case 'error':
      logger.error?.(payload, message)
      break
    case 'fatal':
      logger.fatal?.(payload, message)
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
