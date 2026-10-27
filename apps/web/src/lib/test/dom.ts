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
  const comments: Comment[] = []
  const walker = copy.ownerDocument.createTreeWalker(copy, NodeFilter.SHOW_COMMENT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) comments.push(node as Comment)
  for (const comment of comments) comment.remove()
  for (const script of copy.querySelectorAll('script')) script.textContent = ''
  return copy.innerHTML
}

/**
 * `serializeWithoutNoise` with the indentation that follows a line break removed, for the split
 * pins in `*.states.test.ts`: moving markup into a sub-region component changes its nesting, which
 * re-indents the wrapped prose inside a text node. Every other whitespace character is kept, so a
 * stray whitespace text node still shows.
 */
export function serializeIgnoringIndent(root: Element): string {
  return serializeWithoutNoise(root).replace(/\n[ \t]+/g, '\n')
}

/**
 * Story 63-5: every id under `root` that occurs more than once, and every `aria-describedby` token
 * that does not name exactly one element with text. Empty when each row's help is its own.
 */
export function idProblems(root: ParentNode = document): string[] {
  const counts = new Map<string, number>()
  for (const element of root.querySelectorAll('[id]')) {
    counts.set(element.id, (counts.get(element.id) ?? 0) + 1)
  }
  const repeated = [...counts]
    .filter(([, count]) => count > 1)
    .map(([id, count]) => `id "${id}" occurs ${count} times`)
  const describedIds = [...root.querySelectorAll('[aria-describedby]')].flatMap((control) =>
    (control.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
  )
  const hasText = (id: string): boolean =>
    counts.get(id) === 1 && (root.querySelector(`[id="${id}"]`)?.textContent ?? '').trim() !== ''
  const unresolved = describedIds
    .filter((id) => !hasText(id))
    .map((id) => `aria-describedby "${id}" does not name one element with text`)
  return [...repeated, ...unresolved]
}
