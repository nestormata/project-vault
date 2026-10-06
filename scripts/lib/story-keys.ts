/**
 * Story keys written in free text (`70-3-delivery-provider-contract`), shared by the ledger guards
 * (`check-review-tradeoff-ledger` citations, `check-deferred-work-triggers` stale-trigger rule).
 */
const STORY_KEY_IN_TEXT = /(?<![\w-])\d+-\d+[a-z]?-[a-z][a-z0-9-]*/g

function trimTrailingHyphens(value: string): string {
  let end = value.length
  while (end > 0 && value[end - 1] === '-') end -= 1
  return value.slice(0, end)
}

/** Story keys written in `text`, trailing hyphens trimmed. */
export function citedStoryKeys(text: string): string[] {
  return [...text.matchAll(STORY_KEY_IN_TEXT)].map((m) => trimTrailingHyphens(m[0]))
}
