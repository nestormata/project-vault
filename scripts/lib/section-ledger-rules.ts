/**
 * Story 60.8 (epic-60 retro Finding 4, epic-61 retro Finding 1) — the pure text rules behind the
 * two ledger checks `check-review-tradeoff-ledger` gained:
 *
 * - Rule S: a Residual risks / Scope Boundaries / Known limits section of a `done` story records
 *   a disposition (accepted / needs Nestor / follow-up / deferred) with no ledger citation.
 * - Rule D: a checked `- [x] [Review][Defer]` bullet with no ledger citation.
 *
 * Nothing here reads files or knows the ledger: the script resolves citations. This module owns
 * the shared heading/fence section walker (also used by `extractReviewSections`), the section
 * title predicate, block grouping and the closed disposition phrase list.
 */
import { createFenceTracker } from './deferred-work-ledger.js'

export type BodyLine = { line: number; text: string }

export type Heading = { level: number; title: string }

export function parseHeading(line: string): Heading | undefined {
  const marks = /^(#{1,6})[ \t]+/.exec(line)
  if (!marks) return undefined
  const title = line
    .slice(marks[0].length)
    .replace(/[ \t]#+[ \t]*$/, '')
    .trim()
  return { level: (marks[1] as string).length, title }
}

function opensSection(heading: Heading, isScanned: (heading: Heading) => boolean): boolean {
  return heading.level >= 2 && heading.level <= 4 && isScanned(heading)
}

export type TitledSection = { heading: string; title: string; lines: BodyLine[] }

/**
 * The one heading/fence walker (43.12 AC-1.2, generalized by 60.8): every level 2-4 heading that
 * `isScanned` accepts opens a section running to the next heading of the same or higher level
 * (a deeper subsection stays inside it). Fenced lines are left out and never open or close one.
 */
export function extractSections(
  content: string,
  isScanned: (heading: Heading) => boolean
): TitledSection[] {
  const fenced = createFenceTracker()
  const sections: TitledSection[] = []
  let current: (TitledSection & { level: number }) | undefined
  for (const [index, rawLine] of content.split('\n').entries()) {
    const text = rawLine.replace(/\r$/, '')
    if (fenced(text)) continue
    const heading = parseHeading(text)
    if (heading && current && heading.level <= current.level) current = undefined
    if (heading && !current && opensSection(heading, isScanned)) {
      current = {
        heading: `${'#'.repeat(heading.level)} ${heading.title}`,
        title: heading.title,
        lines: [],
        level: heading.level,
      }
      sections.push(current)
      continue
    }
    current?.lines.push({ line: index + 1, text })
  }
  return sections.map(({ heading, title, lines }) => ({ heading, title, lines }))
}

const NEGATIONS = new Set(['no', 'not', 'none', 'never', 'nothing', 'zero', 'without'])
const SENTENCE_SPLIT = /\. |; /

/** AC-1.4 (43.12): whether one of the negation words is among the three words before `index`. */
export function isNegated(sentence: string, index: number): boolean {
  return sentence
    .slice(0, index)
    .split(/\s+/)
    .filter((word) => word !== '')
    .slice(-3)
    .some((word) => NEGATIONS.has(word.toLowerCase().replaceAll(/[^a-z]/g, '')))
}

// Standalone words: not joined to a letter, digit, `_` or `-` on either side.
const RESIDUAL_RISK = /(?<![\p{L}\p{N}_-])residual risks?(?![\p{L}\p{N}_-])/iu
const SCOPE_BOUNDARY = /(?<![\p{L}\p{N}_-])scope boundar(?:y|ies)(?![\p{L}\p{N}_-])/iu
const KNOWN_LIMIT = /(?<![\p{L}\p{N}_-])known limit(?:s|ation|ations)?(?![\p{L}\p{N}_-])/iu
// Story 70.5 (epic-70 retro Finding 1, 6th occurrence): `### Residual windows (documented, not
// fixed)` was never scanned. `residual` followed by any word is a section; `residuals` and
// `non-residual` are not (the lookbehind and the required whitespace keep them out).
const RESIDUAL_NOUN = /(?<![\p{L}\p{N}_-])residual[ \t]+\p{L}+(?![\p{L}\p{N}_-])/iu
/**
 * The closed list of "not fixed" title phrases that open a section and imply a disposition
 * (retro Finding 1). A bare `not fixed` is deliberately absent: the 70.5 measurement showed it
 * matching decision-record headings ("D9 — ...: accepted, not fixed", "D8 — ... tracked, not
 * fixed, by this story") whose bullets are safeguards, not deferrals. Adding one means editing this constant plus a test and re-measuring the live
 * overlay (60.8 AC-2 rule).
 */
export const UNFIXED_TITLE_PHRASES: readonly RegExp[] = [
  /(?<![\p{L}\p{N}_-])documented,? not fixed(?![\p{L}\p{N}_-])/iu,
  /(?<![\p{L}\p{N}_-])not addressed here(?![\p{L}\p{N}_-])/iu,
]
const ACCEPTED_WORD = /(?<![\p{L}\p{N}_-])accepted(?![\p{L}\p{N}_-])/iu
const EXCLUDED_TITLE = /elicitation|pre-?mortem|red team/i
const AC_TITLE = /^AC-\d+/i

/**
 * Whether a heading opens a Residual risks / Residual <noun> / Scope Boundaries / Known limits /
 * "not fixed" section. An acceptance-criterion title (`AC-14: ... Scope Boundary`) is not a
 * section, and elicitation / pre-mortem / red team sections are excluded like in the
 * review-section extractor.
 */
export function isRiskScopeTitle(title: string): boolean {
  if (AC_TITLE.test(title) || EXCLUDED_TITLE.test(title)) return false
  return (
    RESIDUAL_RISK.test(title) ||
    RESIDUAL_NOUN.test(title) ||
    SCOPE_BOUNDARY.test(title) ||
    KNOWN_LIMIT.test(title) ||
    isUnfixedTitle(title)
  )
}

function isUnfixedTitle(title: string): boolean {
  return UNFIXED_TITLE_PHRASES.some((phrase) => phrase.test(title))
}

/** Whether the title itself records the disposition (a residual risk is accepted by definition). */
export function impliesDisposition(title: string): boolean {
  return (
    ACCEPTED_WORD.test(title) ||
    RESIDUAL_RISK.test(title) ||
    KNOWN_LIMIT.test(title) ||
    isUnfixedTitle(title)
  )
}

export type RiskScopeSection = TitledSection & { impliesDisposition: boolean }

/** Story 60.8 AC-1: the Residual risks / Scope Boundaries / Known limits sections of a story. */
export function extractRiskScopeSections(content: string): RiskScopeSection[] {
  return extractSections(content, (heading) => isRiskScopeTitle(heading.title)).map((section) => ({
    ...section,
    impliesDisposition: impliesDisposition(section.title),
  }))
}

/**
 * The closed disposition phrase list (AC-2), from the epic-60 retro Finding 4 quotes
 * ("documented, accepted", "needs Nestor", "file a follow-up", "deferred"). Adding a phrase means
 * editing this constant plus a test, and re-measuring the live overlay (a noisy phrase gets a
 * guard routed around). `revisit` is deliberately absent: it fires on the sentence that promises
 * a ledger entry.
 */
export const DISPOSITION_PHRASES: readonly RegExp[] = [
  /\baccepted\b/gi,
  /\bneeds? (?:Nestor|a decision|CM coordination)\b/gi,
  /\bwaiting on Nestor\b/gi,
  /\bfollow[- ]?up\b/gi,
  /\bdefer(?:red|s|ring)?\b/gi,
]

const TRAILING_NONE = /^[*\s]*:[*\s]*(?:none|n\/a|nothing)\b/i
const NONE_PARAGRAPH = /^\W*(?:none|n\/a|nothing)\b/i

/** Offset of the first non-negated disposition phrase in `text`, or undefined. */
export function firstDispositionIndex(text: string): number | undefined {
  let offset = 0
  let first: number | undefined
  for (const sentence of text.split(SENTENCE_SPLIT)) {
    for (const phrase of DISPOSITION_PHRASES) {
      for (const match of sentence.matchAll(phrase)) {
        const end = match.index + match[0].length
        if (isNegated(sentence, match.index) || TRAILING_NONE.test(sentence.slice(end))) continue
        const at = offset + match.index
        if (first === undefined || at < first) first = at
      }
    }
    offset += sentence.length + 2
  }
  return first
}

export type TextBlock = { kind: 'bullet' | 'paragraph'; lines: BodyLine[] }

const BULLET = /^(\s*)(?:[-*]|\d+\.)\s/

function isTopBullet(text: string): boolean {
  const indent = BULLET.exec(text)?.[1]
  return indent !== undefined && indent.length < 2
}

/**
 * Groups section lines into blocks: a top-level bullet plus its indented continuation lines and
 * nested bullets, or a blank-line separated paragraph.
 */
export function groupBlocks(lines: BodyLine[]): TextBlock[] {
  const blocks: TextBlock[] = []
  let current: TextBlock | undefined
  let afterBlank = false
  for (const line of lines) {
    if (line.text.trim() === '') {
      afterBlank = true
      continue
    }
    const indented = /^\s{2,}/.test(line.text)
    if (isTopBullet(line.text)) {
      current = { kind: 'bullet', lines: [line] }
      blocks.push(current)
    } else if (current && (indented || !afterBlank)) {
      current.lines.push(line)
    } else {
      current = { kind: 'paragraph', lines: [line] }
      blocks.push(current)
    }
    afterBlank = false
  }
  return blocks
}

export type SectionHit = {
  /** The line of the first hit in the block. */
  line: number
  /** First and last line of the block. */
  startLine: number
  endLine: number
  text: string
  heading: string
}

function lexicalHitLine(block: TextBlock): number | undefined {
  const text = block.lines.map((l) => l.text).join(' ')
  const at = firstDispositionIndex(text)
  if (at === undefined) return undefined
  let start = 0
  for (const l of block.lines) {
    if (at < start + l.text.length + 1) return l.line
    start += l.text.length + 1
  }
  return block.lines.at(-1)?.line
}

function impliedHitBlocks(blocks: TextBlock[]): TextBlock[] {
  const bullets = blocks.filter((b) => b.kind === 'bullet')
  if (bullets.length > 0) return bullets
  return blocks.filter((b) => !NONE_PARAGRAPH.test(b.lines[0]?.text.trim() ?? ''))
}

function blockHit(block: TextBlock, heading: string, line: number): SectionHit {
  return {
    line,
    startLine: block.lines[0]?.line ?? line,
    endLine: block.lines.at(-1)?.line ?? line,
    text: block.lines.map((l) => l.text).join('\n'),
    heading,
  }
}

/**
 * Story 60.8 AC-2: the blocks of one section that record a disposition. In a title-implied
 * section (accepted / residual risk / known limit) every top-level bullet is a hit, or each
 * non-`None` paragraph when there is no bullet; otherwise a block hits on a closed phrase.
 */
export function dispositionHits(section: RiskScopeSection): SectionHit[] {
  const blocks = groupBlocks(section.lines)
  if (section.impliesDisposition) {
    return impliedHitBlocks(blocks).flatMap((block) => {
      const first = block.lines[0]
      return first ? [blockHit(block, section.heading, first.line)] : []
    })
  }
  return blocks.flatMap((block) => {
    const line = lexicalHitLine(block)
    return line === undefined ? [] : [blockHit(block, section.heading, line)]
  })
}

const CHECKED_DEFER = /^\s*[-*]\s+\[x\]\s+\[Review\]\[Defer\]/i
const ANY_BULLET = /^(\s*)(?:[-*]|\d+\.)\s/

export type CheckedDefer = { line: number; endLine: number; text: string }

type ScannedLine = { line: number; text: string; fenced: boolean }

function scanLines(content: string): ScannedLine[] {
  const fenced = createFenceTracker()
  return content.split('\n').map((raw, index) => {
    const text = raw.replace(/\r$/, '')
    return { line: index + 1, text, fenced: fenced(text) }
  })
}

function continues(candidate: ScannedLine, indent: number): boolean {
  if (candidate.fenced || candidate.text.trim() === '' || parseHeading(candidate.text)) return false
  const bulletIndent = ANY_BULLET.exec(candidate.text)?.[1]
  return bulletIndent === undefined || bulletIndent.length > indent
}

/**
 * Story 60.8 AC-4: every checked `[Review][Defer]` bullet outside fences, with its block (the
 * line plus continuation lines up to the next bullet at equal-or-lower indent, a blank line, a
 * heading or a fence).
 */
export function findCheckedDefers(content: string): CheckedDefer[] {
  const lines = scanLines(content)
  const found: CheckedDefer[] = []
  for (const [index, current] of lines.entries()) {
    if (current.fenced || !CHECKED_DEFER.test(current.text)) continue
    const indent = /^\s*/.exec(current.text)?.[0].length ?? 0
    const block = [current.text]
    let endLine = current.line
    for (const next of lines.slice(index + 1)) {
      if (!continues(next, indent)) break
      block.push(next.text)
      endLine = next.line
    }
    found.push({ line: current.line, endLine, text: block.join('\n') })
  }
  return found
}
