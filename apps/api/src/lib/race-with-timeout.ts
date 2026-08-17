export type RaceWithTimeoutResult<T> =
  | { status: 'resolved'; value: T }
  | { status: 'timed_out' }
  | { status: 'rejected'; error: unknown }

/**
 * Races a single async attempt against a bounded timeout. An eager no-op `.catch()` is attached
 * to the attempt promise immediately (before racing) so a late rejection of the "losing" promise
 * — after the timeout already won — can never produce an `unhandledRejection`; a late resolution
 * is simply never consumed (`Promise.race` only reads the first settled promise), so it cannot
 * retroactively mutate the caller's already-finalized state. Shared by
 * `extensions/loader.ts` (extension load) and `lib/capability-gate.ts` (gate invocation), which
 * both need this exact shape.
 */
export async function raceWithTimeout<T>(
  attempt: () => Promise<T>,
  timeoutMs: number
): Promise<RaceWithTimeoutResult<T>> {
  const attemptPromise = attempt()
  attemptPromise.catch(() => undefined)

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error('race-with-timeout: timed out')), timeoutMs)
  })

  try {
    const value = await Promise.race([attemptPromise, timeoutPromise])
    return { status: 'resolved', value }
  } catch (error) {
    if (error instanceof Error && error.message === 'race-with-timeout: timed out') {
      return { status: 'timed_out' }
    }
    return { status: 'rejected', error }
  } finally {
    clearTimeout(timeoutHandle)
  }
}
