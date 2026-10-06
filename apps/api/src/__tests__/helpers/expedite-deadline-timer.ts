import { vi } from 'vitest'

/**
 * Story 66-17 (DW-434 family): proves "the code waits for exactly its configured deadline" without
 * a wall clock. Timers armed with exactly `deadlineMs` fire after 0 ms instead (every other timer
 * is untouched), and `armedCount()` reports how many were armed. A test then asserts the
 * deadline timer was armed with the configured bound (so the code waits no longer and no shorter
 * than the constant says) and that the response a fired deadline produces is the right one,
 * without sleeping through the real deadline.
 *
 * Restored by `vi.restoreAllMocks()` (the delegation suites call it in `afterEach`).
 */
export function expediteDeadlineTimer(deadlineMs: number): { armedCount: () => number } {
  const realSetTimeout = globalThis.setTimeout
  const spy = vi
    .spyOn(globalThis, 'setTimeout')
    .mockImplementation(((handler: () => void, delay?: number, ...args: unknown[]) =>
      realSetTimeout(
        handler,
        delay === deadlineMs ? 0 : delay,
        ...args
      )) as unknown as typeof setTimeout)
  return { armedCount: () => spy.mock.calls.filter((call) => call[1] === deadlineMs).length }
}
