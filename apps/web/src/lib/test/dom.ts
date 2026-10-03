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

/**
 * The markup of `root` with comment nodes removed and every script element emptied, produced by
 * walking the parsed DOM (not by regex over the serialized string), so nested or malformed
 * comment/script text cannot slip through. The source node is left untouched.
 */
export function serializeWithoutNoise(root: Element): string {
  const copy = root.cloneNode(true) as Element
  const comments: Node[] = []
  const walker = copy.ownerDocument.createTreeWalker(copy, NodeFilter.SHOW_COMMENT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) comments.push(node)
  for (const comment of comments) comment.parentNode?.removeChild(comment)
  for (const script of copy.querySelectorAll('script')) script.textContent = ''
  return copy.innerHTML
}
