import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Where story files (and the private overlay's sprint-status.yaml/deferred-work.md) live. */
export const STORIES_DIR = '_bmad-output/implementation-artifacts'

export type ResolvedStoryFile = { path: string; content: string }

/**
 * This project has used two story-file naming conventions over time: the plain `<key>.md`
 * form, and a `spec-<key>.md` form (see e.g. `spec-9-9-...md`, `spec-21-5-...md`). Try both
 * rather than assuming the plain form — a `spec-`-prefixed story silently skipped
 * (DW-138/DW-139) is indistinguishable from a real integrity gap. Returns `undefined` when neither
 * file can be read (missing, or a dangling symlink: `check-story-status-sync` owns those).
 * Extracted from check-followup-review-gate.ts by Story 43.12 so its second caller
 * (check-review-tradeoff-ledger.ts) does not copy it.
 */
export function resolveStoryFile(root: string, storyKey: string): ResolvedStoryFile | undefined {
  const candidatePaths = [
    resolve(root, STORIES_DIR, `${storyKey}.md`),
    resolve(root, STORIES_DIR, `spec-${storyKey}.md`),
  ]
  for (const path of candidatePaths) {
    try {
      return { path, content: readFileSync(path, 'utf-8') }
    } catch {
      continue
    }
  }
  return undefined
}
