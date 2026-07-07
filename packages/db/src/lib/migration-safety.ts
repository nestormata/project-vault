/**
 * Story 9.3 D2: static, DB-free detection of destructive SQL operations in a migration file's
 * raw text. Used both by the runtime guard (`scripts/guarded-migrate.ts`, only scans *pending*
 * migrations before invoking drizzle-kit) and the CI-only full-history gate
 * (root `scripts/migration-compatibility-check.ts`, scans every migration ever committed) — this
 * module is the single source of truth for "what counts as destructive" so the two call sites
 * can never drift apart (and so `pnpm jscpd` never has two near-identical copies to flag).
 *
 * Before pattern-matching, comments and string literals are stripped (replaced with
 * same-length whitespace, preserving line numbers) so a destructive keyword appearing only in a
 * SQL comment or inside a string literal's contents never produces a false positive.
 */

type Finding = { label: string; index: number }

const DOLLAR_TAG_RE = /^\$[A-Za-z0-9_]*\$/

/** Replaces every non-newline character with a space, preserving the original length and any
 * newlines — so downstream line-number computation on the stripped text still lines up with the
 * original source. */
function maskPreservingNewlines(text: string): string {
  return text.replace(/[^\n]/g, ' ')
}

/** Each `try*` consumer below inspects `sql` starting at `i` and, if it recognizes the token
 * starting there, returns the exclusive end index of that token; otherwise returns `null` so the
 * caller falls through to the next consumer (or a plain single-character copy). */
type TokenConsumer = (sql: string, i: number, n: number) => number | null

/** Line comment: "-- ..." through end of line (exclusive of the newline itself). */
const tryLineComment: TokenConsumer = (sql, i, n) => {
  if (sql[i] !== '-' || sql[i + 1] !== '-') return null
  let j = i
  while (j < n && sql[j] !== '\n') j++
  return j
}

/** Block comment: "/* ... *\/" (unterminated block comments run to end of input). */
const tryBlockComment: TokenConsumer = (sql, i, n) => {
  if (sql[i] !== '/' || sql[i + 1] !== '*') return null
  const close = sql.indexOf('*/', i + 2)
  return close === -1 ? n : close + 2
}

/** Dollar-quoted string: "$tag$ ... $tag$" (tag may be empty, e.g. plain "$$...$$"). */
const tryDollarQuotedString: TokenConsumer = (sql, i, n) => {
  if (sql[i] !== '$') return null
  const tagMatch = DOLLAR_TAG_RE.exec(sql.slice(i))
  if (!tagMatch) return null
  const tag = tagMatch[0]
  const close = sql.indexOf(tag, i + tag.length)
  return close === -1 ? n : close + tag.length
}

/** Single-quoted string literal, with standard SQL '' escaping. */
const trySingleQuotedString: TokenConsumer = (sql, i, n) => {
  if (sql[i] !== "'") return null
  let j = i + 1
  while (j < n) {
    if (sql[j] === "'" && sql[j + 1] === "'") {
      j += 2
      continue
    }
    if (sql[j] === "'") return j + 1
    j++
  }
  return j
}

const TOKEN_CONSUMERS: TokenConsumer[] = [
  tryLineComment,
  tryBlockComment,
  tryDollarQuotedString,
  trySingleQuotedString,
]

/**
 * Strips SQL line comments (`-- ...`), block comments (`/* ... *\/`), single-quoted string
 * literals (with `''`-escaping), and dollar-quoted strings (`$$...$$` / `$tag$...$tag$`) from
 * `sql`, replacing each with whitespace of identical length so every remaining character's index
 * (and therefore line number) is unchanged from the original input.
 */
function stripCommentsAndStrings(sql: string): string {
  let result = ''
  let i = 0
  const n = sql.length

  while (i < n) {
    const j = TOKEN_CONSUMERS.reduce<number | null>(
      (found, consume) => found ?? consume(sql, i, n),
      null
    )
    if (j !== null) {
      result += maskPreservingNewlines(sql.slice(i, j))
      i = j
      continue
    }

    result += sql[i]
    i++
  }

  return result
}

function lineForIndex(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line++
  }
  return line
}

/** Splits `text` on `separator` only at paren-nesting depth 0, so a separator occurring inside
 * e.g. `varchar(10,2)` does not split a single column definition in two. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

const SIMPLE_PATTERNS: { label: string; regex: RegExp }[] = [
  { label: 'DROP COLUMN', regex: /\bDROP\s+COLUMN\b/gi },
  { label: 'DROP TABLE', regex: /\bDROP\s+TABLE\b/gi },
  { label: 'RENAME COLUMN', regex: /\bRENAME\s+COLUMN\b/gi },
  { label: 'RENAME TO', regex: /\bRENAME\s+TO\b/gi },
  { label: 'TRUNCATE', regex: /\bTRUNCATE\b/gi },
  { label: 'DELETE FROM', regex: /\bDELETE\s+FROM\b/gi },
  { label: 'DROP CONSTRAINT', regex: /\bDROP\s+CONSTRAINT\b/gi },
  { label: 'DROP DEFAULT', regex: /\bDROP\s+DEFAULT\b/gi },
  // Deliberately conservative (D2 point 1): flags every ALTER COLUMN ... TYPE change, including
  // safe widening ones — narrowing vs. widening can't be told apart without introspecting the
  // live schema, which this static scan never does. Excludes "ALTER COLUMN ... SET NOT NULL"
  // (no TYPE keyword present, so it never matches this pattern) by design (AC-18).
  // The identifier alternation (`"[^"]*"|[\w]+`) matches either a quoted Postgres identifier
  // (which may contain hyphens, spaces, or other non-word characters, e.g. `"risk-score"`) or a
  // bare unquoted one — a bare `"?[\w]+"?` cannot match a quoted identifier containing a
  // non-word character at all, silently letting that specific TYPE change bypass detection
  // entirely (found during code review; regression-tested below).

  {
    label: 'ALTER COLUMN ... TYPE',
    regex: /\bALTER\s+COLUMN\s+(?:"[^"]*"|[\w]+)\s+(?:SET\s+DATA\s+)?TYPE\b/gi,
  },
]

function findSimplePatternMatches(strippedText: string, findings: Finding[]): void {
  for (const { label, regex } of SIMPLE_PATTERNS) {
    for (const match of strippedText.matchAll(regex)) {
      findings.push({ label, index: match.index })
    }
  }
}

/** `ADD COLUMN ... NOT NULL` where the same column-definition clause has no `DEFAULT` — this
 * fails (or requires a backfill) against a non-empty table. Scoped per top-level clause (split on
 * statement, then on paren-aware commas) so a compound `ALTER TABLE ... ADD COLUMN a, ADD COLUMN
 * b NOT NULL` only flags clause `b`, and a `DEFAULT` appearing either before or after `NOT NULL`
 * within the same clause correctly suppresses the finding. */
function findAddColumnNotNullWithoutDefault(strippedText: string, findings: Finding[]): void {
  let statementOffset = 0
  for (const statement of strippedText.split(';')) {
    let clauseOffset = statementOffset
    for (const clause of splitTopLevel(statement, ',')) {
      if (
        /\bADD\s+COLUMN\b/i.test(clause) &&
        /\bNOT\s+NULL\b/i.test(clause) &&
        !/\bDEFAULT\b/i.test(clause)
      ) {
        const relativeIndex = clause.search(/\bADD\s+COLUMN\b/i)
        findings.push({
          label: 'ADD COLUMN ... NOT NULL (no DEFAULT)',
          index: clauseOffset + Math.max(relativeIndex, 0),
        })
      }
      clauseOffset += clause.length + 1 // +1 for the ',' separator
    }
    statementOffset += statement.length + 1 // +1 for the ';' separator
  }
}

/**
 * Scans `sql` (the full raw text of one migration file) for destructive operations and returns a
 * human-readable finding per match (empty array if none found). Comment and string-literal
 * contents are stripped before scanning (see module doc), and matching is case-insensitive.
 */
export function findDestructiveStatements(sql: string): string[] {
  const stripped = stripCommentsAndStrings(sql)
  const findings: Finding[] = []

  findSimplePatternMatches(stripped, findings)
  findAddColumnNotNullWithoutDefault(stripped, findings)

  findings.sort((a, b) => a.index - b.index)

  return findings.map(({ label, index }) => `${label} (line ${lineForIndex(sql, index)})`)
}
