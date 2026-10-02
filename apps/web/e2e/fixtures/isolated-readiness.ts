import type { ChildProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { StderrTail, earlyExitMessage } from './isolated-api-exit.js'

/**
 * Story 66.10 (DW-422): readiness for a spawned isolated API that never returns a dead child and
 * never leaves a running one behind. Story 66.4 already rejects when the child exits first; this
 * adds (1) a check of the child's own state and identity once `/health` answers, so a stale
 * process answering on the port cannot win the race against a child that dies of EADDRINUSE, and
 * (2) the kill of the still-running child when readiness fails for any other reason.
 */

export type ReadinessOptions = {
  child: ChildProcess
  label: string
  port: number
  stderrTail: StderrTail
  /** Resolves once `/health` answered ok, rejects when the poll budget is exhausted. */
  probeHealth: (signal: AbortSignal) => Promise<void>
  /** True only when the process answering on the port is this child. */
  confirmIdentity: () => Promise<boolean>
  stop: (child: ChildProcess) => Promise<void>
  /** How long to wait for a wrong-identity responder's child to exit (EADDRINUSE) before giving up. */
  identityGraceMs: number
}

type Exit = { code: number | null; signal: NodeJS.Signals | null }
type HealthFailure = { healthError: unknown }

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function exitMessage(options: ReadinessOptions, exit: Exit): string {
  return earlyExitMessage(
    options.label,
    options.port,
    exit.code,
    exit.signal,
    options.stderrTail.reason()
  )
}

async function failAndStop(options: ReadinessOptions, message: string): Promise<never> {
  await options.stop(options.child)
  throw new Error(`${message}; child logs: ${options.stderrTail.reason()}`)
}

/** Listens on `close` (not `exit`): `exit` can fire before the stdio pipes drain. */
function watchExit(child: ChildProcess): { exited: Promise<Exit>; dispose: () => void } {
  let listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
  const exited = new Promise<Exit>((resolve) => {
    listener = (code, signal) => resolve({ code, signal })
    child.once('close', listener)
  })
  return {
    exited,
    dispose: () => {
      if (listener) child.off('close', listener)
    },
  }
}

export async function waitForIsolatedApiReady(options: ReadinessOptions): Promise<void> {
  const controller = new AbortController()
  const watcher = watchExit(options.child)
  try {
    const healthy = options.probeHealth(controller.signal).then(
      (): undefined => undefined,
      (error: unknown): HealthFailure => ({ healthError: error })
    )
    const first = await Promise.race([healthy, watcher.exited])
    if (first === undefined) {
      await confirmChildAnswered(options, watcher.exited)
    } else if ('healthError' in first) {
      const error = first.healthError
      await failAndStop(options, error instanceof Error ? error.message : String(error))
    } else {
      throw new Error(exitMessage(options, first))
    }
  } finally {
    controller.abort()
    watcher.dispose()
  }
}

/** `/health` answered: make sure it was OUR child that answered. */
async function confirmChildAnswered(
  options: ReadinessOptions,
  exited: Promise<Exit>
): Promise<void> {
  const { child } = options
  if (childHasExited(child)) {
    throw new Error(exitMessage(options, { code: child.exitCode, signal: child.signalCode }))
  }
  if (await options.confirmIdentity()) return
  // Something else answered. If our child is dying of EADDRINUSE it exits shortly: report that.
  const outcome = await Promise.race([exited, delay(options.identityGraceMs).then(() => undefined)])
  if (outcome !== undefined) throw new Error(exitMessage(options, outcome))
  await failAndStop(
    options,
    `/health on ${options.label}:${options.port} was answered by a different process`
  )
}
