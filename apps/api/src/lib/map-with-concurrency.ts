/**
 * Maps `items` through the async `fn` with at most `limit` calls in flight at once, resolving to
 * the results in input order (like `Promise.all(items.map(fn))`, but bounded).
 *
 * Use it instead of an unbounded `Promise.all` whenever each call holds a scarce resource — e.g.
 * a pooled DB connection for a `withOrg` transaction — so a large input cannot drain the shared
 * pool, and instead of a sequential `for ... await` loop when the items are independent.
 *
 * Fail-fast like `Promise.all`: the returned promise rejects with the first error, and no further
 * items are started after it (calls already in flight are allowed to finish).
 *
 * Each of the `min(limit, items.length)` workers pulls the next unclaimed item when its current
 * call settles — recursion rather than a loop, so a worker only ever waits on its own call.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`mapWithConcurrency: limit must be a positive integer, got ${limit}`)
  }

  // One iterator shared by every worker: each `next()` hands out a distinct, not-yet-started item.
  const pending = items.entries()
  const results = new Map<number, R>()
  let failed = false

  const runWorker = async (): Promise<void> => {
    if (failed) return
    const next = pending.next()
    if (next.done) return
    const [index, item] = next.value
    try {
      results.set(index, await fn(item))
    } catch (error) {
      failed = true
      throw error
    }
    return runWorker()
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runWorker))
  return Array.from(items, (_, index) => results.get(index) as R)
}
