import pino from 'pino'
import type { FastifyBaseLogger } from 'fastify'
import { OperationalEvent } from '@project-vault/shared'
import type { Env } from '../config/env.js'
import { findDbErrorCause } from './db-error-cause.js'
import { findExtensionBootFailure } from '../extensions/boot-errors.js'
import { createFixedLevelLogger, operationalLog, serializeLogError } from './logger.js'

type FlushableLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'> & {
  flush?: () => void | Promise<void>
}

export async function flushLogger(logger: FlushableLogger): Promise<void> {
  await logger.flush?.()
}

export async function logStartupFailure(logger: FlushableLogger, err: unknown): Promise<void> {
  // Story 43.28 AC-1: name the database cause by its code (closed reason set), never by driver
  // text; the key is omitted when no link carries a code, so other lines stay byte-identical.
  const cause = findDbErrorCause(err)
  // Story 68.8 Q15: an extension boot failure (VAULT_EXTENSIONS_REQUIRED, apiRoutes drift,
  // collision or schema rejection) gets a sibling `extension` key with a closed reason; the DB
  // `cause` key above is unchanged.
  const extension = findExtensionBootFailure(err)
  operationalLog(logger, 'error', OperationalEvent.STARTUP_FAILED, 'API startup failed', {
    err: serializeLogError(err),
    ...(cause ? { cause } : {}),
    ...(extension ? { extension } : {}),
  })
  await flushLogger(logger)
}

/** Synchronous stderr: the line must be on fd 2 before the caller's `process.exit(1)`. */
export function stderrDestination(): pino.DestinationStream {
  return pino.destination({ dest: 2, sync: true })
}

/**
 * Story 66.4 AC-2: reports an API startup failure as exactly one redacted `startup.failed` JSON
 * line on stderr, whatever NODE_ENV and LOG_LEVEL say (`silent`/`fatal` used to swallow it, and
 * NODE_ENV=test forced `silent`). It uses its own error-level logger with the standard options
 * (redaction, service, message key) instead of the configured one, so the configured logger is
 * never asked for a second copy. Never rejects: if the structured write throws (EPIPE, closed
 * fd), it falls back to a plain redacted `Fatal error:` line, and if that throws too there is
 * nothing left to write to, so the caller's exit code stays 1 either way.
 */
export async function reportStartupFailure(
  env: Pick<Env, 'NODE_ENV' | 'LOG_LEVEL' | 'SERVICE_NAME'>,
  err: unknown,
  destination: pino.DestinationStream = stderrDestination()
): Promise<void> {
  try {
    await logStartupFailure(createFixedLevelLogger(env, 'error', destination), err)
  } catch {
    writeFatalFallback(err)
  }
}

function writeFatalFallback(err: unknown): void {
  try {
    process.stderr.write(`Fatal error: ${serializeLogError(err).message}\n`)
  } catch {
    // stderr itself is gone: nothing can carry the reason any more; the exit code still does.
  }
}
