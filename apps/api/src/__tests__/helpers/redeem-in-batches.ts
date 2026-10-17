/**
 * Story 65.5 test helper: runs `count` calls of `call` in sequential batches of `batchSize`
 * concurrent calls and returns every settled result in order.
 *
 * Batches keep a burst under the host's per-extension in-flight cap
 * (`CREDENTIAL_SHARING_HOST_MAX_IN_FLIGHT_PER_EXTENSION`, 20) and avoid an `await` inside a loop:
 * the batches are chained on one promise. Settled (not rejected) results let a caller assert that
 * EVERY call resolved and see the first rejection reason when one did not.
 *
 * `afterBatchStarted` runs once per batch, after its calls have started and before they are awaited:
 * a fake-timer test advances the clock there so the 65.4 miss floor releases the held calls.
 */
export async function redeemInBatches<T>(
  count: number,
  call: () => Promise<T>,
  options: { batchSize?: number; afterBatchStarted?: () => Promise<void> } = {}
): Promise<PromiseSettledResult<T>[]> {
  const batchSize = options.batchSize ?? 8
  const batches = Math.ceil(count / batchSize)
  let chain: Promise<PromiseSettledResult<T>[]> = Promise.resolve([])
  for (let batch = 0; batch < batches; batch++) {
    chain = chain.then(async (settled) => {
      const size = Math.min(batchSize, count - settled.length)
      const pending = Array.from({ length: size }, () => call())
      await options.afterBatchStarted?.()
      return [...settled, ...(await Promise.allSettled(pending))]
    })
  }
  return chain
}

/** The first rejection reason of a settled list, or `undefined` when every call fulfilled. */
export function firstRejection(settled: PromiseSettledResult<unknown>[]): unknown {
  return settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    ?.reason
}
