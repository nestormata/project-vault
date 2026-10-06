/**
 * Calls the async `fn` over `items` strictly one after another, in input order, and resolves to the
 * first result that is neither `null` nor `undefined` (or `undefined` when every call yields
 * none). Later items are not started once a result is found, and the first rejection stops the
 * walk.
 *
 * Use it for bounded retry/probe loops and "first match" scans whose iterations are not
 * independent (a shared `tx`, a unique-collision retry, an early `return`) and where a
 * `for ... await` loop would trip `no-await-in-loop` / Sonar S9382. For loops that run to the end
 * use `forEachSequential`; for independent work use `mapWithConcurrency`.
 *
 * Recursion rather than a loop, so each step only ever waits on its own call. A synchronous throw
 * from `fn` becomes a rejection, like an async function.
 */
export function firstResultSequential<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R | null | undefined>,
  start = 0
): Promise<R | undefined> {
  if (start >= items.length) return Promise.resolve(undefined)
  return Promise.resolve()
    .then(() => fn(items.at(start) as T, start))
    .then((result) => result ?? firstResultSequential(items, fn, start + 1))
}
