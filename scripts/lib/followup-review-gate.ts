/**
 * Story 22.7 — the `followup_review_recommended` closure-time hard gate.
 *
 * `followup_review_recommended: true` becomes a hard commitment (Epic 21 retro action item
 * A21-1) rather than decoration: a story cannot reach `done` while it is set, unless the flag is
 * satisfied by an actual follow-up review pass (flipping the flag to `false`), an explicit
 * written waiver, or a live `deferred-work.md` ledger entry tracking the outstanding review —
 * matching the `DW-132`/`DW-133`/`DW-135` precedent exactly.
 *
 * `evaluateFollowupReviewGate` is pure and DB-free: it never touches the filesystem itself.
 * Callers (the CI backstop in `check-followup-review-gate.ts`, or any future closure-time caller)
 * supply the story's status and file content directly, which is what makes it usable against a
 * *candidate* status transition — "if I were about to set this story's status to `done`, would
 * that be a `block`?" — not only after the transition is already committed.
 */

export type FollowupReviewGateVerdict = 'not-applicable' | 'pass' | 'block'

/** Statuses this gate evaluates. Any other status (in-progress, review, backlog, ...) is not-applicable. */
const CLOSING_STATUS = 'done'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Extracts a top-level `key: value` line's raw value. Recognizes both frontmatter conventions
 * already coexisting in this repository: the simple `Key: value` lines used by Story 22.6, and
 * the YAML-block `---...---` convention used by Stories 22.1/22.2/20.5 — both place the key
 * unindented at the start of a line, so a single line-anchored regex covers both without a real
 * YAML parser. Never throws on malformed/truncated content; simply returns undefined.
 */
function extractFrontmatterValue(content: string, key: string): string | undefined {
  const match = new RegExp(`^${escapeRegExp(key)}:[ \\t]*(.*)$`, 'm').exec(content)
  return match?.[1]?.trim()
}

function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

/** True only when `followup_review_recommended` is present and its value is literally `true`. */
export function hasFollowupReviewRecommended(storyFileContent: string): boolean {
  const raw = extractFrontmatterValue(storyFileContent, 'followup_review_recommended')
  if (raw === undefined) return false
  return stripQuotes(raw).toLowerCase() === 'true'
}

/**
 * Returns the waiver text if a non-empty, non-placeholder `followup_review_waiver:` value is
 * present, otherwise undefined. `TBD` (any casing) and an empty string do not count — a
 * placeholder must not silently satisfy the gate.
 */
export function extractFollowupReviewWaiver(storyFileContent: string): string | undefined {
  const raw = extractFrontmatterValue(storyFileContent, 'followup_review_waiver')
  if (raw === undefined) return undefined
  const value = stripQuotes(raw)
  if (value === '' || value.toUpperCase() === 'TBD') return undefined
  return value
}

/**
 * True if `deferred-work.md` already contains a ledger entry tracking this exact story key —
 * either via a `source_spec:` field naming the story's file, or (fallback, for a future entry
 * that titles itself slightly differently or omits `source_spec:`) via the story key appearing
 * as a full token in a `### DW-...` entry heading. Matching is on the full normalized story key,
 * not a substring — a near-miss like `22-1` inside `22-10` must not produce a false match.
 */
export function isTrackedInDeferredWork(storyKey: string, deferredWorkContent: string): boolean {
  const key = storyKey.trim()
  if (!key) return false
  const escapedKey = escapeRegExp(key)

  const sourceSpecRegex = new RegExp(`source_spec:\\s*\`?${escapedKey}\\.md\`?`)
  if (sourceSpecRegex.test(deferredWorkContent)) return true

  const tokenBoundary = '(?:^|[^a-zA-Z0-9._-])'
  const tokenBoundaryEnd = '(?:$|[^a-zA-Z0-9._-])'
  const titleTokenRegex = new RegExp(`${tokenBoundary}${escapedKey}${tokenBoundaryEnd}`)

  const headings = deferredWorkContent.match(/^###\s*DW-[^\n]*$/gm) ?? []
  return headings.some((heading) => titleTokenRegex.test(heading))
}

/**
 * Computes the closure decision for one story. Pure — never reads `sprint-status.yaml` or the
 * filesystem itself; callers supply `storyStatus` (the actual, or a *candidate*, status) and
 * `storyFileContent`/`deferredWorkContent` directly.
 */
export function evaluateFollowupReviewGate(
  storyKey: string,
  storyStatus: string,
  storyFileContent: string,
  deferredWorkContent: string
): FollowupReviewGateVerdict {
  if (!hasFollowupReviewRecommended(storyFileContent)) return 'not-applicable'
  if (storyStatus !== CLOSING_STATUS) return 'not-applicable'

  if (extractFollowupReviewWaiver(storyFileContent) !== undefined) return 'pass'
  if (isTrackedInDeferredWork(storyKey, deferredWorkContent)) return 'pass'

  return 'block'
}
