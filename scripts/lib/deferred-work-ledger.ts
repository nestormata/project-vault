/**
 * Story 43.11 — the one shared parser for `deferred-work.md` DW entry headings. Used by both the
 * duplicate-ID guard (check-deferred-work-ids.ts) and the ID allocator (next-dw-id.ts): a second
 * regex drifting from the guard's is how an ID the guard sees becomes invisible to the allocator.
 * Story 43.12 extends this module with entry bodies (`parseDwEntries`), the shared fence tracker
 * and DW-ID citations in prose, all on the same ID character class.
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
/** Story 43.12 AC-2 rule 3: a `DW-<id>` mention in prose, same ID run as `DW_HEADING`. */
const DW_CITATION = /(?<![0-9A-Za-z])DW-([0-9A-Za-z][0-9A-Za-z.-]*)/g
const ANY_HEADING = /^#{1,6}(?:[ \t]|$)/
const FLAT_SOURCE_SPEC_BULLET = /^[-*][ \t]+source_spec:/
const STATUS_PREFIX = 'status:'
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
    marker?.startsWith(fence.char) === true &&
    marker.length >= fence.length &&
    line.trim() === marker
  )
}

/**
 * A stateful per-line fence classifier: call it on every line in order; it returns true for a
 * fence's opening/closing line and every line inside a fence (an unclosed fence runs to EOF).
 * The one fence state machine shared by the DW parsers and Story 43.12's review-section reader.
 */
export function createFenceTracker(): (line: string) => boolean {
  let fence: Fence | undefined
  return (line: string): boolean => {
    if (fence) {
      if (closesFence(line, fence)) fence = undefined
      return true
    }
    fence = openingFence(line)
    return fence !== undefined
  }
}

/** One body line of a DW entry. */
export type DwBodyLine = { line: number; text: string }

type LedgerLine = DwBodyLine & { heading?: DwHeading; otherHeading: boolean }

function toDwHeading(line: string, lineNumber: number): DwHeading | undefined {
  const match = DW_HEADING.exec(line)
  if (!match) return undefined
  const id = `DW-${idToken(match[2] as string)}`
  return {
    id,
    normalizedId: normalizeDwId(id),
    line: lineNumber,
    level: (match[1] as string).length,
  }
}

/** Every non-fenced line (CR stripped), classified as a DW heading, another heading, or text. */
function ledgerLines(content: string): LedgerLine[] {
  const fenced = createFenceTracker()
  const lines: LedgerLine[] = []
  for (const [index, rawLine] of content.split('\n').entries()) {
    const text = rawLine.replace(/\r$/, '')
    if (fenced(text)) continue
    const heading = toDwHeading(text, index + 1)
    lines.push({ line: index + 1, text, heading, otherHeading: !heading && ANY_HEADING.test(text) })
  }
  return lines
}

export function parseDwHeadings(content: string): DwHeading[] {
  return ledgerLines(content).flatMap((l) => (l.heading ? [l.heading] : []))
}

/** Story 43.12 AC-5.1: a DW heading plus its body. */
export type DwEntry = DwHeading & {
  /** 1-based first body line (the line after the heading). */
  bodyStartLine: number
  /** 1-based last body line, inclusive; `bodyStartLine - 1` for an empty body. */
  bodyEndLine: number
  /** The body's non-fenced lines. */
  lines: DwBodyLine[]
}

/** Whether `current` ends the body collected so far (`sawStatus`: a `status:` line was seen). */
function endsBody(current: LedgerLine, sawStatus: boolean): boolean {
  return (
    current.heading !== undefined ||
    current.otherHeading ||
    (sawStatus && FLAT_SOURCE_SPEC_BULLET.test(current.text))
  )
}

/**
 * Story 43.12 AC-5.1: every DW entry with its body. A body runs from the line after the heading to
 * just before the first of: the next DW heading, any other heading, a flat `- source_spec:` /
 * `* source_spec:` bullet at or after the entry's first `status:` line (the format doc's flat-block
 * terminator; mirrors bmad-loop's `parse_ledger`), or EOF. Fenced lines are left out of `lines`
 * and never end a body.
 */
export function parseDwEntries(content: string): DwEntry[] {
  const all = ledgerLines(content)
  const totalLines = content.split('\n').length
  const entries: DwEntry[] = []
  for (const [index, current] of all.entries()) {
    if (!current.heading) continue
    const body: DwBodyLine[] = []
    let sawStatus = false
    let end = totalLines
    for (const next of all.slice(index + 1)) {
      if (endsBody(next, sawStatus)) {
        end = next.line - 1
        break
      }
      sawStatus ||= next.text.startsWith(STATUS_PREFIX)
      body.push({ line: next.line, text: next.text })
    }
    entries.push({
      ...current.heading,
      bodyStartLine: current.heading.line + 1,
      bodyEndLine: end,
      lines: body,
    })
  }
  return entries
}

/** Story 43.12 AC-2 rule 3: every `DW-<id>` cited in `text`, trimmed like a heading ID
 * (`DW-344.` -> `DW-344`); compare them on `normalizeDwId`. A `DW-` right after `.`/`-` starts a
 * new citation, so `DW-355..DW-391` and `DW-318-DW-319` each cite both IDs (the ID run would
 * otherwise swallow the second one). */
export function extractDwCitations(text: string): string[] {
  return [...text.replaceAll(/([.-])(?=DW-)/g, '$1 ').matchAll(DW_CITATION)]
    .map((match) => idToken(match[1] as string))
    .filter((token) => token !== '')
    .map((token) => `DW-${token}`)
}
