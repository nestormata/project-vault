/**
 * Fault-containment conformance helpers (Story 67.1).
 *
 * Contract: the PV API host loads an extension in-process. Node treats an `'error'` event on an
 * emitter with no `'error'` listener, and a rejected promise nobody handles, as fatal for the
 * whole process. Every long-lived emitter an extension creates (database pools, sockets, streams,
 * clients) MUST therefore carry an `'error'` listener, and every background promise MUST have a
 * rejection handler. These helpers let an extension prove that in its own CI, before it ships.
 *
 * They report labels and counts only, never error text, so a failing run cannot leak a connection
 * string into CI logs.
 */

/** The structural slice of a Node `EventEmitter` (a `pg.Pool` is one) the helper needs. */
export interface ConformanceEmitter {
  listenerCount(eventName: string): number
  emit(eventName: string, ...args: unknown[]): boolean
}

export interface EmitterConformanceResult {
  readonly ok: boolean
  /** Labels of the emitters that crashed when an `'error'` event was forced on them. */
  readonly violations: readonly string[]
}

export interface BackgroundPromiseConformanceResult {
  readonly ok: boolean
  readonly unhandledCount: number
}

/**
 * Forces a synthetic `'error'` event on every emitter and reports the ones that throw (a
 * listener-less emitter rethrows it, which in a running host is the process-killing path). An
 * emitter that has a listener is invoked with the synthetic error, so listeners must tolerate it.
 */
export function checkExtensionEmitters(
  emitters: Readonly<Record<string, ConformanceEmitter>>
): EmitterConformanceResult {
  const violations: string[] = []
  for (const [label, emitter] of Object.entries(emitters)) {
    if (emitter.listenerCount('error') === 0) {
      violations.push(label)
      continue
    }
    try {
      emitter.emit('error', new Error('extension-api conformance probe'))
    } catch {
      violations.push(label)
    }
  }
  return { ok: violations.length === 0, violations }
}

/** Throws (naming only the offending labels) unless every emitter survives a forced `'error'`. */
export function assertExtensionEmittersContained(
  emitters: Readonly<Record<string, ConformanceEmitter>>
): void {
  const { ok, violations } = checkExtensionEmitters(emitters)
  if (!ok) {
    throw new Error(
      `Extension emitters without a working 'error' listener: ${violations.join(', ')}`
    )
  }
}

/**
 * The slice of the Node runtime the background-promise check needs. Declared structurally because
 * this package's public sources compile without `@types/node` (the api-surface generator
 * enforces that), and the helper only ever runs under Node, in an extension's CI.
 */
interface NodeRuntimeSlice {
  readonly process: {
    on(event: 'unhandledRejection', listener: () => void): unknown
    removeListener(event: 'unhandledRejection', listener: () => void): unknown
  }
  readonly setImmediate: (callback: () => void) => unknown
}

/**
 * Runs `run` and reports any promise rejection that was left unhandled while it ran (and one
 * macrotask after). Use it around the code path that starts an extension's background work.
 */
export async function checkBackgroundPromisesHandled(
  run: () => void | Promise<void>
): Promise<BackgroundPromiseConformanceResult> {
  const runtime = globalThis as unknown as NodeRuntimeSlice
  let unhandledCount = 0
  const onUnhandled = (): void => {
    unhandledCount += 1
  }
  runtime.process.on('unhandledRejection', onUnhandled)
  try {
    await run()
    await new Promise<void>((resolve) => runtime.setImmediate(resolve))
  } finally {
    runtime.process.removeListener('unhandledRejection', onUnhandled)
  }
  return { ok: unhandledCount === 0, unhandledCount }
}
