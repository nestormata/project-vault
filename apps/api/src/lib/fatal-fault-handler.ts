import { OperationalEvent } from '@project-vault/shared'
import { operationalLog } from './logger.js'
import { raceWithTimeout } from './race-with-timeout.js'
import { zeroKeys as zeroKeyMaterial } from '../modules/vault/key-service.js'

/**
 * Story 67.1 — the last-resort process-level fault handler.
 *
 * An extension runs in this process. When its async code leaks a fault (an `'error'` event on an
 * emitter with no listener, an unhandled rejection) Node surfaces it as `uncaughtException` or
 * `unhandledRejection`, and the process state is undefined from then on. This handler therefore
 * NEVER swallows and never resumes serving: it zeroes key material first, writes one attributed
 * and redacted fatal line, closes the server within a bound, and exits non-zero so the supervisor
 * restarts the process. It is a backstop; the primary control is the extension-api contract
 * (every emitter carries an `'error'` listener, every promise is handled).
 */

type FatalLogger = Parameters<typeof operationalLog>[0]

export interface FatalFaultHandlerDeps {
  /** Resolved lazily: the Fastify logger does not exist yet when the handler is installed. */
  getLogger: () => FatalLogger
  /** The configured extension package name (`VAULT_EXTENSIONS_PACKAGE`), if any. */
  getExtensionPackage: () => string | undefined
  /** The loaded extension's manifest name, if one is loaded. */
  getExtensionName: () => string | undefined
  /** Graceful close of the server; bounded by `closeTimeoutMs`. */
  close?: () => Promise<unknown>
  zeroKeys?: () => void
  exit?: (code: number) => void
  closeTimeoutMs?: number
}

const DEFAULT_CLOSE_TIMEOUT_MS = 5_000
const SAFE_ERROR_NAME = /^[A-Za-z0-9_.$-]{1,64}$/
const SAFE_ERROR_CODE = /^[A-Z0-9_]{1,64}$/

type FaultOrigin = 'uncaughtException' | 'unhandledRejection'

function safeErrorName(reason: unknown): string {
  if (!(reason instanceof Error)) return 'NonError'
  return SAFE_ERROR_NAME.test(reason.name) ? reason.name : 'Error'
}

function safeErrorCode(reason: unknown): string | undefined {
  if (!(reason instanceof Error)) return undefined
  const code = (reason as Error & { code?: unknown }).code
  return typeof code === 'string' && SAFE_ERROR_CODE.test(code) ? code : undefined
}

/**
 * Advisory only: true when the stack passes through the extension package's install path. A
 * hostile extension can forge a stack, so this never influences the exit decision.
 */
function stackNamesPackage(reason: unknown, packageName: string | undefined): boolean {
  if (!packageName || !(reason instanceof Error) || typeof reason.stack !== 'string') return false
  const flat = packageName.replace('/', '+')
  return (
    reason.stack.includes(`node_modules/${packageName}/`) ||
    reason.stack.includes(`node_modules/.pnpm/${flat}@`)
  )
}

/** Installs the handler; the returned function removes it again (tests only). */
export function registerFatalFaultHandler(deps: FatalFaultHandlerDeps): () => void {
  const zeroKeys = deps.zeroKeys ?? zeroKeyMaterial
  const exit = deps.exit ?? ((code: number) => process.exit(code))
  const closeTimeoutMs = deps.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS
  let handling = false

  const report = (origin: FaultOrigin, reason: unknown): void => {
    const attributed = stackNamesPackage(reason, deps.getExtensionPackage())
    const errorCode = safeErrorCode(reason)
    operationalLog(
      deps.getLogger(),
      'fatal',
      OperationalEvent.PROCESS_FATAL_FAULT,
      'Fatal process fault: exiting so the supervisor restarts the API',
      {
        origin,
        errorName: safeErrorName(reason),
        ...(errorCode ? { errorCode } : {}),
        attribution: attributed ? 'extension' : 'unattributed',
        extension: attributed ? (deps.getExtensionName() ?? null) : null,
      }
    )
  }

  const handle = async (origin: FaultOrigin, reason: unknown): Promise<void> => {
    if (handling) {
      // A second fault while already exiting: nothing more can be trusted, leave now.
      exit(1)
      return
    }
    handling = true
    try {
      // CRITICAL: zero in-memory key material FIRST (mirrors shutdown.ts), whatever else fails.
      try {
        zeroKeys()
      } catch {
        // best effort: the exit below still happens
      }
      try {
        report(origin, reason)
      } catch {
        // a broken logger must not keep the process alive
      }
      if (deps.close) await raceWithTimeout(deps.close, closeTimeoutMs)
    } finally {
      exit(1)
    }
  }

  const onUncaught = (error: unknown): Promise<void> => handle('uncaughtException', error)
  const onRejection = (reason: unknown): Promise<void> => handle('unhandledRejection', reason)
  process.on('uncaughtException', onUncaught)
  process.on('unhandledRejection', onRejection)
  return () => {
    process.removeListener('uncaughtException', onUncaught)
    process.removeListener('unhandledRejection', onRejection)
  }
}
