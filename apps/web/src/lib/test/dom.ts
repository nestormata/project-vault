/**
 * Story 68.1 (Q2): the element at `index` (negative counts from the end) of a query result,
 * failing the test with a clear message when it does not exist, so test code reads a defined
 * element under `noUncheckedIndexedAccess` without a non-null assertion.
 */
export function nth<T>(items: readonly T[], index: number): T {
  const item = items.at(index)
  if (item === undefined)
    throw new Error(`expected an element at index ${index} of ${items.length}`)
  return item
}
