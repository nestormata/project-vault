/**
 * Story 43.11 — the one shared parser for `deferred-work.md` DW entry headings. Used by both the
 * duplicate-ID guard (check-deferred-work-ids.ts) and the ID allocator (next-dw-id.ts): a second
 * regex drifting from the guard's is how an ID the guard sees becomes invisible to the allocator.
 * Story 43.12 extends this module (entry bodies) rather than writing another DW regex.
 *
 * Contract (epic-43 retro Finding 2):
 * - A DW heading is `^(#{1,6})[ \t]+DW-<id>` at column 0, `<id>` = `[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*`,
 *   ending at the first character outside that class (typically `:`, whitespace or end of line).
 *   `###DW-5` (no space), lowercase `dw-5` and dash look-alikes (`DW–276`) are not DW headings.
 * - Headings inside ``` / ~~~ fenced code blocks are ignored; an unclosed fence runs to EOF.
 * - IDs compare on `normalizedId`: lowercased, leading zeros stripped from every purely numeric
 *   segment (`DW-0276` == `DW-276`), never by numeric prefix (`DW-24` != `DW-24-1`).
 */

export type DwHeading = {
  /** The ID exactly as written, e.g. `DW-23.2-1`. */
  id: string
  /** Case- and leading-zero-normalized ID used for comparisons, e.g. `dw-23.2-1`. */
  normalizedId: string
  /** 1-based line number. */
  line: number
  /** Markdown heading level (number of `#`). */
  level: number
}

// The ID is the longest `[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*` run; matched here as a flat character
// run and trimmed by `idToken` (no nested quantifier to backtrack over).
const DW_HEADING = /^(#{1,6})[ \t]+DW-([0-9A-Za-z][0-9A-Za-z.-]*)/
const FENCE = /^ {0,3}(`{3,}|~{3,})/

/** `DW-0276` -> `dw-276`, `DW-24-05` -> `dw-24-5`, `DW-12A` -> `dw-12a`. */
export function normalizeDwId(id: string): string {
  return id
    .toLowerCase()
    .split(/([.-])/)
    .map((segment) => (/^\d+$/.test(segment) ? String(Number.parseInt(segment, 10)) : segment))
    .join('')
}

/** Cuts a flat `[0-9A-Za-z.-]*` run to the contract's ID: stop before a doubled separator and drop
 * a trailing one (`5.:` -> `5`, `24--x` -> `24`). */
function idToken(run: string): string {
  const doubled = /[.-]{2}/.exec(run)
  const cut = doubled ? run.slice(0, doubled.index) : run
  return cut.replace(/[.-]$/, '')
}

type Fence = { char: string; length: number }

/** The fence a line opens, or undefined. */
function openingFence(line: string): Fence | undefined {
  const marker = FENCE.exec(line)?.[1]
  return marker === undefined ? undefined : { char: marker[0] as string, length: marker.length }
}

/** Whether `line` closes `fence`: same character, at least as long, nothing else after it. */
function closesFence(line: string, fence: Fence): boolean {
  const marker = FENCE.exec(line)?.[1]
  return (
    marker !== undefined &&
    marker[0] === fence.char &&
    marker.length >= fence.length &&
    line.trim() === marker
  )
}

export function parseDwHeadings(content: string): DwHeading[] {
  const headings: DwHeading[] = []
  let fence: Fence | undefined

  for (const [index, rawLine] of content.split('\n').entries()) {
    const line = rawLine.replace(/\r$/, '')
    if (fence) {
      if (closesFence(line, fence)) fence = undefined
      continue
    }
    fence = openingFence(line)
    if (fence) continue

    const match = DW_HEADING.exec(line)
    if (match) {
      const id = `DW-${idToken(match[2] as string)}`
      headings.push({
        id,
        normalizedId: normalizeDwId(id),
        line: index + 1,
        level: (match[1] as string).length,
      })
    }
  }
  return headings
}
