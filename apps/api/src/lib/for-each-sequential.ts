/**
 * Runs the async `fn` over `items` strictly one after another, in input order. Stops at the first
 * rejection (later items are not started) and resolves once every item has settled successfully.
 *
 * Use it where the work must stay sequential — a single DB transaction connection, ordered
 * side effects, hash chains — and a `for ... await` loop would trip Sonar S9382. For independent
 * work prefer `mapWithConcurrency`.
 *
 * Recursion rather than a loop, so each step only ever waits on its own call.
 */
export function forEachSequential<T>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<unknown>,
  start = 0
): Promise<void> {
  if (start >= items.length) return Promise.resolve()
  // A Promise executor turns a synchronous throw from `fn` into a rejection, like an async fn.
  return Promise.resolve()
    .then(() => fn(items.at(start) as T, start))
    .then(() => forEachSequential(items, fn, start + 1))
}
