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

const DOLLAR_TAG_RE = /^\$\w*\$/

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

/** Finds a dollar-quote boundary starting at `i` (tag may be empty, e.g. plain "$$"). Returns
 * the tag text and the index where the matching closing tag begins, or `null` if `i` isn't the
 * start of one (`closeStart` is -1 if the tag never closes). */
function matchDollarQuoteBoundary(
  sql: string,
  i: number
): { tag: string; closeStart: number } | null {
  if (sql[i] !== '$') return null
  const tagMatch = DOLLAR_TAG_RE.exec(sql.slice(i))
  if (!tagMatch) return null
  const tag = tagMatch[0]
  const closeStart = sql.indexOf(tag, i + tag.length)
  return { tag, closeStart }
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

/** Double-quoted identifier: `"..."`, with standard SQL `""`-escaping. Unlike the maskable
 * consumers below, the caller preserves this token's content verbatim rather than masking it —
 * see stripCommentsAndStrings for why. */
const tryDoubleQuotedIdentifier: TokenConsumer = (sql, i, n) => {
  if (sql[i] !== '"') return null
  let j = i + 1
  while (j < n) {
    if (sql[j] === '"' && sql[j + 1] === '"') {
      j += 2
      continue
    }
    if (sql[j] === '"') return j + 1
    j++
  }
  return j
}

const MASKING_TOKEN_CONSUMERS: TokenConsumer[] = [
  tryLineComment,
  tryBlockComment,
  trySingleQuotedString,
]

/**
 * Strips SQL line comments (`-- ...`), block comments (`/* ... *\/`), and single-quoted string
 * literals (with `''`-escaping) from `sql`, replacing each with whitespace of identical length so
 * every remaining character's index (and therefore line number) is unchanged from the original
 * input.
 *
 * Two token kinds are handled separately from the generic masking pass above, both because they
 * need un-masked content preserved and because letting the generic scanners see their raw
 * characters causes desyncs (found via edge-case review, regression-tested below):
 *  - Double-quoted identifiers (`"..."`) are boundary-matched but copied through verbatim, so an
 *    embedded `--`/`'`/`$` inside a quoted identifier (e.g. `"note--legacy"`) can't be
 *    misinterpreted as the start of a comment/string/dollar-quote and swallow real statements
 *    that follow on the same line. Identifier text must also survive intact for the
 *    `ALTER COLUMN "quoted-name" TYPE` pattern below to still match it.
 *  - Dollar-quoted blocks (`$$...$$` / `$tag$...$tag$`) are boundary-matched and their interior
 *    is *recursively* stripped rather than masked wholesale. A `DO $$ ... $$` or
 *    `CREATE FUNCTION ... $$ ... $$` body is executable PLpgSQL, not inert string data — masking
 *    it let a destructive statement wrapped in a dollar-quoted block bypass this guard entirely.
 *    Recursing still strips genuine nested comments/string-literal contents (so those don't
 *    produce false positives or desync the scan) while leaving destructive keywords in the block
 *    body visible to the outer pattern scan.
 */
function stripCommentsAndStrings(sql: string): string {
  let result = ''
  let i = 0
  const n = sql.length

  while (i < n) {
    const identifierEnd = tryDoubleQuotedIdentifier(sql, i, n)
    if (identifierEnd !== null) {
      result += sql.slice(i, identifierEnd)
      i = identifierEnd
      continue
    }

    const boundary = matchDollarQuoteBoundary(sql, i)
    if (boundary) {
      const { tag, closeStart } = boundary
      if (closeStart === -1) {
        result += maskPreservingNewlines(sql.slice(i, n))
        i = n
        continue
      }
      const openEnd = i + tag.length
      const inner = sql.slice(openEnd, closeStart)
      result +=
        maskPreservingNewlines(tag) + stripCommentsAndStrings(inner) + maskPreservingNewlines(tag)
      i = closeStart + tag.length
      continue
    }

    const j = MASKING_TOKEN_CONSUMERS.reduce<number | null>(
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
  // Story 23.5: privilege DDL changes the security boundary and must be reviewed explicitly.
  { label: 'CREATE ROLE', regex: /\bCREATE\s+ROLE\b/gi },
  { label: 'ALTER ROLE', regex: /\bALTER\s+ROLE\b/gi },
  { label: 'DROP ROLE', regex: /\bDROP\s+ROLE\b/gi },
  { label: 'GRANT privilege', regex: /\bGRANT\b/gi },
  { label: 'REVOKE privilege', regex: /\bREVOKE\b/gi },
  { label: 'ALTER DEFAULT PRIVILEGES', regex: /\bALTER\s+DEFAULT\s+PRIVILEGES\b/gi },
  // Story 24.1: these statements can silently remove the ownership/FORCE boundary. Story 23.5
  // may extend this same scanner with privilege patterns; keep one scanner and one source of truth.
  { label: 'NO FORCE ROW LEVEL SECURITY', regex: /\bNO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY\b/gi },
  { label: 'DISABLE ROW LEVEL SECURITY', regex: /\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/gi },
  { label: 'OWNER TO postgres', regex: /\bOWNER\s+TO\s+postgres\b/gi },
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
    regex: /\bALTER\s+COLUMN\s+(?:"[^"]*"|\w+)\s+(?:SET\s+DATA\s+)?TYPE\b/gi,
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

/**
 * Deliberately narrow, file-scoped allowlist (mirrors `apps/api/src/lib/route-exemptions.ts`'s
 * pattern) for already-shipped, already-reviewed migrations that are newly caught by tightened
 * scanning here, not by an accidental destructive change. Keyed by migration tag (filename minus
 * `.sql`) so both call sites (`guarded-migrate.ts`'s pending-only runtime guard and
 * `migration-compatibility-check.ts`'s full-history CI gate) can share one source of truth. A file
 * is only ever added here with a documented reason — this must never become a way to silently wave
 * through a genuinely new destructive migration.
 *
 * `0036_audit_search_export_forwarding`: `stripCommentsAndStrings` now recurses into
 * dollar-quoted (`$$...$$`) blocks instead of masking them wholesale, so a destructive statement
 * hidden inside a `DO`/`CREATE FUNCTION` body can no longer bypass this guard (closed via
 * edge-case review — see the regression tests above). That closes a real gap, but it also makes
 * this migration newly "destructive" under the tightened scan: its
 * `purge_expired_audit_log_entries()` `SECURITY DEFINER` function body contains a
 * `DELETE FROM audit_log_entries`, the sanctioned, narrowly-scoped exception to the audit log's
 * append-only trigger (Story 8.1/8.2 design) — not an accidental schema change. Left unlisted,
 * this would (a) block every brand-new self-hosted install's very first `db:migrate` run, since
 * `guarded-migrate.ts` treats a fresh database's entire local history as "pending", and (b) break
 * AC-18's full-history zero-findings guarantee for a migration that was reviewed and merged before
 * this story existed.
 *
 * `0047_notification_preference_none_channel`: Postgres cannot widen an existing CHECK
 * constraint in place, so this reviewed migration temporarily drops and re-adds the exact same
 * constraint name with one additive new allowed value (`'none'`) for durable notification opt-out
 * persistence. The repo-inspection safety test for 0047 proves there are no column drops, type
 * rewrites, table drops, or data-deleting statements hiding alongside that constraint rewrite.
 */
export const KNOWN_REVIEWED_DESTRUCTIVE_MIGRATIONS: Record<string, string> = {
  '0036_audit_search_export_forwarding':
    "purge_expired_audit_log_entries()'s DELETE FROM audit_log_entries is the sanctioned, RLS-context-checked exception to the append-only trigger (Story 8.1/8.2) — reviewed and merged before Story 9.3 tightened dollar-quoted-block scanning.",
  // Story 9.4 AC-17/D5: purge_expired_platform_audit_entries()'s DELETE FROM platform_audit_events
  // is the exact same sanctioned pattern as 0036 above (SECURITY DEFINER function, session-flag-
  // gated append-only-trigger escape hatch), for the new platform-level audit table this story
  // introduces — a genuinely destructive-looking DELETE that is intentionally scoped and reviewed,
  // not an accidental schema change.
  '0042_platform_audit_retention_purge':
    "purge_expired_platform_audit_entries()'s DELETE FROM platform_audit_events is the sanctioned, session-flag-gated exception to this story's own append-only trigger — same pattern as 0036's audit_log_entries purge function.",
  '0047_notification_preference_none_channel':
    "notification_preferences_channel_check must be dropped and re-added to widen its allowed set with the new reviewed 'none' opt-out value; the paired migration safety test verifies no unrelated destructive schema/data change rides along.",
  // Story 5.6 AC-7/Task 1: rotations_status_check must be dropped and re-added (same
  // cannot-widen-in-place limitation as 0047) to add 'staged'/'promoted'/'retired' while keeping
  // every existing value. The paired migration safety test verifies the only DROP CONSTRAINT/
  // ADD CONSTRAINT pair present is this exact rewrite, with no unrelated destructive statement.
  '0050_staged_rotation_state_machine':
    "rotations_status_check must be dropped and re-added to widen its allowed set with the new 'staged'/'promoted'/'retired' values — identical reviewed pattern to 0047's notification_preferences_channel_check widening.",
  // Story 23.8 AC-8: audit_log_entries_actor_type_check must be dropped and re-added (same
  // cannot-widen-in-place limitation as 0047/0050) to add 'extension' while keeping every
  // existing value. The paired migration safety test verifies the only DROP CONSTRAINT/ADD
  // CONSTRAINT pair present is this exact rewrite, with no unrelated destructive statement.
  '0078_audit_log_entries_extension_actor_type':
    "audit_log_entries_actor_type_check must be dropped and re-added to widen its allowed set with the new 'extension' value — identical reviewed pattern to 0047/0050's CHECK-constraint widenings.",
  // Story 24.5a: 0080 changes only function ACLs and default privileges. Registered
  // pre-emptively so a later privilege-pattern expansion in Story 23.5 cannot make a fresh
  // bootstrap fail; migration-0080-function-grants.test.ts proves no function body or data
  // operation is bundled with the ACL change.
  '0080_security_definer_function_grants':
    'Story 24.5a audit purge/trigger function ACL narrowing and default-privilege narrowing; paired safety test proves the migration contains no function body or data operation.',
  '0081_extension_db_role':
    'Story 23.5 reviewed role bootstrap, least-privilege schema access, and operator approval-table ACLs; paired migration safety tests assert it contains no data deletion, FORCE RLS, PUBLIC revoke, or default-privilege widening.',
  // Historical privilege migrations predate the privilege-pattern expansion. They remain
  // explicitly reviewed so a fresh database can replay the immutable migration history; any new
  // privilege DDL must still be added with a deliberate review entry like 0081 above.
  '0001_rls_and_triggers':
    'Historical RLS bootstrap privilege DDL reviewed before the privilege scanner existed.',
  '0002_audit_log_revoke':
    'Historical audit ACL narrowing reviewed before the privilege scanner existed.',
  '0003_vault_state':
    'Historical vault-state ACL setup reviewed before the privilege scanner existed.',
  '0004_auth_sessions_refresh':
    'Historical auth-session ACL setup reviewed before the privilege scanner existed.',
  '0006_platform_security_events':
    'Historical platform-security ACL setup reviewed before the privilege scanner existed.',
  '0007_session_revocation':
    'Historical session-revocation ACL setup reviewed before the privilege scanner existed.',
  '0008_mfa_foundation': 'Historical MFA ACL setup reviewed before the privilege scanner existed.',
  '0009_auth_rate_limit_buckets':
    'Historical auth-rate-limit ACL setup reviewed before the privilege scanner existed.',
  '0010_failed_auth_attempts':
    'Historical failed-auth ACL setup reviewed before the privilege scanner existed.',
  '0011_pending_mfa_sessions':
    'Historical pending-MFA ACL setup reviewed before the privilege scanner existed.',
  '0041_platform_audit_events':
    'Historical platform-audit ACL setup reviewed before the privilege scanner existed.',
  '0070_rls_ownership_and_force':
    'Historical RLS ownership privilege setup reviewed before the privilege scanner existed.',
  '0071_admin_pool_role':
    'Historical admin-pool role bootstrap reviewed before the privilege scanner existed.',
  '0072_vault_owner_schema_usage':
    'Historical vault-owner schema ACL setup reviewed before the privilege scanner existed.',
  '0075_audit_org_storage_quota':
    'Historical audit-quota ACL setup reviewed before the privilege scanner existed.',
  '0076_audit_org_storage_usage_admin_grant':
    'Historical audit-usage ACL setup reviewed before the privilege scanner existed.',
  '0079_audit_storage_quota_config_admin_grant':
    'Historical audit-quota-config ACL setup reviewed before the privilege scanner existed.',
  // Story 20.8 AC-5: brand-new, RLS-isolated `extension_ephemeral_state` table's own
  // vault_app CRUD grant — same reviewed pattern as 0081's table-creation-time ACL. The paired
  // migration-0084-safety.test.ts proves this migration creates exactly one new table, adds no
  // ALTER on any pre-existing table, and contains no DROP/RENAME/TRUNCATE/DELETE.
  '0084_extension_ephemeral_state':
    'Story 20.8 reviewed table-creation-time vault_app CRUD grant on the new extension_ephemeral_state table; paired migration safety test proves it is a single additive CREATE TABLE with no destructive statement riding along.',
  // Story 20.8 AC-11: vault_admin's cleanup-worker least-privilege ACL on the same table —
  // narrow SELECT(id, expires_at)/DELETE only, same reviewed pattern as 0076/0079's admin grants.
  // The paired migration-0085-safety.test.ts proves this file contains no schema/column change,
  // only the two documented GRANT statements.
  '0085_extension_ephemeral_state_admin_grant':
    'Story 20.8 reviewed vault_admin least-privilege grant (SELECT id/expires_at + DELETE) for the ephemeral-state cleanup worker; paired migration safety test proves it is grant-only with no schema/column change.',
}
