import { compareCodeUnits } from '../paths.js'

export interface ComposeBatch {
  /** The changed paths collected since the last compose, sorted. */
  paths: string[]
  /** True when the manifest changed: the dev plugin then re-composes everything. */
  full: boolean
}

export interface ComposeQueueOptions {
  debounceMs: number
  run: (batch: ComposeBatch) => Promise<void>
  onError?: (error: unknown) => void
}

export interface ComposeQueue {
  schedule: (path: string, manifestChanged?: boolean) => void
  /** Resolves when nothing is scheduled or running. */
  idle: () => Promise<void>
}

/** A debounced, coalescing, single-flight queue: rapid saves collapse into one compose, and events
 * that arrive while one runs queue exactly one follow-up (never two composes writing one tree). */
export function createComposeQueue(options: ComposeQueueOptions): ComposeQueue {
  let paths = new Set<string>()
  let full = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<void> | undefined
  const waiters: (() => void)[] = []

  const settle = (): void => {
    if (timer === undefined && running === undefined && paths.size === 0) {
      for (const done of waiters.splice(0)) done()
    }
  }

  const start = (): void => {
    timer = undefined
    if (running !== undefined || paths.size === 0) return
    const batch: ComposeBatch = { paths: [...paths].sort(compareCodeUnits), full }
    paths = new Set()
    full = false
    running = options
      .run(batch)
      .catch((error: unknown) => options.onError?.(error))
      .finally(() => {
        running = undefined
        // Events that arrived during the run get exactly one follow-up compose.
        if (paths.size > 0) start()
        settle()
      })
  }

  return {
    schedule(path, manifestChanged = false) {
      paths.add(path)
      if (manifestChanged) full = true
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(start, options.debounceMs)
    },
    idle() {
      return new Promise<void>((done) => {
        waiters.push(done)
        settle()
      })
    },
  }
}
