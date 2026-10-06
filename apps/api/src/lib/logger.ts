import pino from 'pino'
import type { FastifyBaseLogger } from 'fastify'
import { SYSTEM_TRACE_ID } from '@project-vault/shared'
import type { Env } from '../config/env.js'
import { PINO_REDACT_PATHS } from './redact-paths.js'

export type LoggerConfig = ReturnType<typeof buildPinoOptions>
export type SerializedLogError = { message: string; name?: string; stack?: string }
type LoggerEnv = Pick<Env, 'NODE_ENV' | 'LOG_LEVEL' | 'SERVICE_NAME'>

// Userinfo (`user@`, `user:secret@`, or an email address used as the user) runs to the last '@'
// before whitespace or '/', so a scheme-prefixed string with no '@' is rejected in linear time (no
// ReDoS: the scan stops at the next '/', and no quantified group nests another quantifier, per
// security/detect-unsafe-regex). The leading negative
// lookbehind makes a match attempt start only at the beginning of a run of scheme characters;
// without it every letter after a '.', '+' or '-' in a long `a.a.a.` run restarts a scan to the end
// of the run (quadratic, ~10 s for 100k characters). Leading `[.+-]*` keeps `.postgres://u:p@h`
// covered, because such a run cannot begin with a letter.
const CONNECTION_STRING_RE = /(?<![a-z0-9+.-])([.+-]*[a-z][a-z0-9+.-]*:\/\/)[^\s/]+@/gi

function redactConnectionStrings(value: string | undefined): string | undefined {
  return value?.replace(CONNECTION_STRING_RE, '$1[REDACTED]@')
}

/** Fixed mask for a recipient address in a log line. A partial mask would leak the domain. */
export const EMAIL_REDACTION_PLACEHOLDER = '[REDACTED_EMAIL]'

// `local@label.label[.label...]`. The local part is an RFC 5322 atext subset (Unicode letters and
// digits allowed); the domain needs at least two dot-separated labels so `postgres@localhost` and
// `user@host` stay readable. The leading negative lookbehind on a local-part character means a
// match attempt starts only at the beginning of a run, so a long run with no '@' is scanned once
// (linear) instead of once per start position (quadratic). The domain is `label.` then a run ending in
// a letter or digit (so a trailing sentence period is left out), with no nested quantifier.
const EMAIL_RE =
  /(?<![\p{L}\p{N}._%+\-'!#$&*/=?^{|}~])[\p{L}\p{N}._%+\-'!#$&*/=?^{|}~]+@[\p{L}\p{N}-]+\.[\p{L}\p{N}.-]*[\p{L}\p{N}]/gu

function redactEmailAddresses(value: string | undefined): string | undefined {
  return value?.replace(EMAIL_RE, EMAIL_REDACTION_PLACEHOLDER)
}

// Connection strings first (their userinfo can itself be an address), then bare addresses.
function redactLogText(value: string | undefined): string | undefined {
  return redactEmailAddresses(redactConnectionStrings(value))
}

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
 * Story 66.4 AC-3: the logger config for the real process entrypoint (`main.ts`). Unlike
 * `createLoggerConfig(env)`, it honours `env.LOG_LEVEL` under NODE_ENV=test as well: test-mode
 * quietness is a property of in-process test suites (which never import main.ts), not of a real
 * process boot such as the isolated e2e API, whose `J*_DEBUG_LOG_LEVEL` knobs set LOG_LEVEL.
 */
export function createEntrypointLoggerConfig(env: LoggerEnv): LoggerConfig {
  return buildPinoOptions(env, env.LOG_LEVEL)
}

/** A pino logger with every standard option (redaction, service, message key) at a fixed
 * level, writing to an explicit destination. Used by the startup-failure reporter. */
export function createFixedLevelLogger(
  env: LoggerEnv,
  level: pino.Level,
  destination: pino.DestinationStream
): pino.Logger {
  return pino(buildPinoOptions(env, level), destination)
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
      message: redactLogText(err.message) ?? '',
      stack: redactLogText(err.stack),
    }
  }
  try {
    return { message: redactLogText(String(err)) ?? '' }
  } catch {
    return { message: 'Unable to serialize thrown value' }
  }
}
