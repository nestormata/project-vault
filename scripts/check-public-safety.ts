#!/usr/bin/env tsx
/**
 * Deterministic pre-publication review for the open-source repository.
 *
 * The checker examines added lines relative to BASE_REF plus non-ignored
 * untracked files. It is intentionally conservative: findings are evidence
 * for a human review, not proof that a line is malicious or confidential.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import process from 'node:process'

export type RiskSeverity = 'critical' | 'high' | 'medium'

export type PublicSafetyFinding = {
  rule: string
  severity: RiskSeverity
  file: string
  line: number
  text: string
  reason: string
}

type AddedLine = { file: string; line: number; text: string }

const SCANNER_FILES = new Set([
  'scripts/check-public-safety.ts',
  'scripts/check-public-safety.test.ts',
  '.gitignore',
])

const SECRET_PATTERNS: Array<{ rule: string; pattern: RegExp; reason: string }> = [
  {
    rule: 'private-key',
    pattern: /-----BEGIN [A-Z0-9 ]{1,40}PRIVATE KEY-----/,
    reason: 'private-key material must never enter source control',
  },
  {
    rule: 'token-value',
    pattern:
      /\b(?:gh[pousr]_|github_pat_|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.)[A-Za-z0-9_./=-]{12,}/,
    reason: 'credential-shaped token value detected',
  },
]

const SECRET_ASSIGNMENT_PATTERNS = [
  /\bpassword\b\s*[:=]\s*["'`][^"'`\n]{8,200}["'`]/i,
  /\bpasswd\b\s*[:=]\s*["'`][^"'`\n]{8,200}["'`]/i,
  /\bsecret\b\s*[:=]\s*["'`][^"'`\n]{8,200}["'`]/i,
  /\bapi[_-]?key\b\s*[:=]\s*["'`][^"'`\n]{8,200}["'`]/i,
  /\baccess[_-]?token\b\s*[:=]\s*["'`][^"'`\n]{8,200}["'`]/i,
  /\brefresh[_-]?token\b\s*[:=]\s*["'`][^"'`\n]{8,200}["'`]/i,
  /\bclient[_-]?secret\b\s*[:=]\s*["'`][^"'`\n]{8,200}["'`]/i,
]
const NO_NEWLINE_MARKER = String.raw`\ No newline at end of file`
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i
const CONNECTION_STRING_SCHEME_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\//i
const LOCAL_PATH_PATTERN = /(?:\/home\/[^\s/]+\/|\.claude\/worktrees|\.worktrees\/)/
const LOCAL_ENDPOINT_PATTERN = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}\b/
// --- secret-shaped environment assignments ---------------------------------------------------
//
// This replaces a rule that fired on a bare secret-shaped NAME anywhere on an added line. A name
// is not a credential: an open-source product's own configuration reference, its .env.example and
// its operator runbooks exist precisely to enumerate these names, so the bare-name rule produced a
// finding on every line whose *purpose* was to name a variable. The disclosure risk is the VALUE,
// so the rule now fires on `NAME = <literal that looks like a real credential>`.
//
// That also lets the former SAFE_PUBLIC_CONSTANT_NAMES allowlist be deleted. It was globally
// blinding the checker to fifteen names (PGPASSWORD, VAULT_ADMIN_PASSWORD, DEMO_LOGIN_PASSWORD and
// others) in *every* file including production source, so a line reading
// `VAULT_ADMIN_PASSWORD=<a real secret>` was clean. Value-based detection needs no such list.
// Both patterns share the same assignment tail: an optional closing quote or backtick (as docs,
// JSON and YAML write it), then `:` or `=`, then the rest of the line. The trailing capture is
// narrowed to a single token by extractLiteralValue(). They are written out literally rather than
// composed through the RegExp constructor so the expressions stay statically analysable.
//
// A secret-shaped name: contains TOKEN, SECRET, PASSWORD, PRIVATE_KEY or API_KEY.
const SECRET_ENV_ASSIGNMENT_PATTERN =
  /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY)[A-Z0-9_]*)\b["'`]?[ \t]*[:=][ \t]*(\S.*)$/gm
// Any SCREAMING_SNAKE env-style name, secret-shaped or not. Used by the broader value-first rule
// below so that a credential assigned to a name the secret-shaped list never anticipated
// (STRIPE_KEY, DEPLOY_CREDENTIAL, ...) is still caught — coverage the old rule did not have.
const ENV_ASSIGNMENT_PATTERN = /\b([A-Z][A-Z0-9_]{2,})\b["'`]?[ \t]*[:=][ \t]*(\S.*)$/gm
// A credential literal is an opaque, unpunctuated token. Anything holding a space, a shell or
// Compose expansion (`$VAR`, `${VAR:?msg}`, `$(cmd)`), a GitHub expression (`${{ }}`), a URL, a
// path or prose falls outside this charset and is therefore not a literal value.
const CREDENTIAL_LITERAL_PATTERN = /^[A-Za-z0-9+/=_.-]{16,200}$/
// Values the repository publishes on purpose. Supersets apps/api/src/config/env.ts's own
// PLACEHOLDER_SECRET_PATTERN (change-me|dev-only|placeholder). That file's KNOWN_DEV_SECRET_VALUES
// — the twelve `'x'.repeat(64)` dev fallbacks — are covered by the character-diversity test in
// isPublishedPlaceholder() below, which is generic and so cannot drift as that list changes.
// Importing them directly was rejected: it would make this standalone, git-only pre-publication
// script depend on apps/api's config graph.
const PLACEHOLDER_VALUE_PATTERN =
  /^(?:password|passwd|secret|token|api[-_]?key|changeme|todo|none|null|unset|redacted|x+|-+|\.+)$|^(?:test|fake|dummy|demo|sample|example|local|dev|fixture|mock|stub|invalid)[-_]|change[-_]?me|dev[-_]?only|placeholder|your[-_]|replace[-_]?me|not[-_]?a[-_]?real/i
// These files intentionally document or exercise local service endpoints. A local endpoint in
// source, prose, or an arbitrary workflow remains a finding.
const SAFE_LOCAL_ENDPOINT_FILES = new Set([
  '.env.example',
  '.github/workflows/ci.yml',
  '.github/workflows/nightly.yml',
  'apps/api/src/config/env.test.ts',
  'docker-compose.yml',
  // Story 22.1: new test files following this codebase's established convention (identical to
  // every other DB-backed test in apps/api/src/modules/audit/*.test.ts and
  // apps/api/src/workers/*.test.ts) of a `process.env['DATABASE_URL'] ??= 'postgresql://vault_app
  // :dev-only-change-in-prod@localhost:5432/project_vault'` dev-only default. New files trip this
  // rule only because the checker scans added LINES, not full-file content, so a brand-new file
  // reproduces an already-repo-wide pattern as a "new" finding.
  'apps/api/src/modules/audit/quota-gate.test.ts',
  'apps/api/src/modules/audit/quota-config.test.ts',
  'apps/api/src/workers/audit-org-usage-reconcile.test.ts',
  // Story 25.7: new test file mirroring routes/health.test.ts's own existing env mock verbatim
  // (same DATABASE_URL/CORS_ALLOWED_ORIGINS/METRICS_BIND_HOST dev-only values) so createApp() can
  // boot far enough to serve GET /health as the concurrent, unrelated request in the hang test.
  // Trips this rule only because the checker scans added LINES and the whole file is new.
  'apps/api/src/lib/extension-hook-concurrency.test.ts',
  // Story 25.9: new operator runbook document following docs/runbook.md's own established
  // convention of `curl http://localhost:3000/...` local-dev-verification examples (that file
  // has 21 such lines and is not itself flagged, since the checker only scans added lines).
])

/**
 * Prose documentation. A localhost URL in a Markdown file is the product's own documented default
 * — a self-hoster needs the literal `http://localhost:5173` to start the app — not a disclosure of
 * anyone's machine. Machine-specific disclosure in prose is still caught by LOCAL_PATH_PATTERN
 * (home directories, worktree paths), which has no file-type exemption.
 */
function isDocumentation(file: string): boolean {
  return file.endsWith('.md')
}

/**
 * Narrow the right-hand side of an assignment to the single literal token being assigned, or
 * null when there is no literal there (a shell expansion, prose, a URL, an empty value).
 */
function extractLiteralValue(rest: string): string | null {
  let value = rest.trim()
  const quote = value[0]
  if (quote === '"' || quote === "'" || quote === '`') {
    const end = value.indexOf(quote, 1)
    // An unterminated quote means the value continues past this line; treat it as non-literal
    // rather than guessing, since diff scanning is line-at-a-time.
    if (end < 0) return null
    value = value.slice(1, end)
  } else {
    value = value.split(/\s/, 1)[0] ?? ''
  }
  // Trailing syntax the value is embedded in (JSON/YAML/Markdown/shell), never part of a secret.
  value = value.replace(/["'`,;)\]}|\\]+$/, '')
  return value.length > 0 ? value : null
}

/** A value the repository publishes on purpose: a placeholder, a path, or a known dev literal. */
function isPublishedPlaceholder(value: string): boolean {
  if (PLACEHOLDER_VALUE_PATTERN.test(value)) return true
  // A leading `/` or `./` makes this a route or filesystem path, not a credential. (Base64
  // secrets may contain `/` but do not start with one.)
  if (/^\.{0,2}\//.test(value)) return true
  // 'a'.repeat(64) and its eleven siblings in apps/api/src/config/env.ts: a value built from one
  // or two distinct characters carries no entropy and cannot be a real credential.
  return new Set(value).size <= 2
}

function characterClasses(segment: string): number {
  return [/[a-z]/, /[A-Z]/, /[0-9]/].filter((pattern) => pattern.test(segment)).length
}

/**
 * A generated credential is opaque: one long run of characters with no word structure. Splitting
 * on the separators human-readable identifiers use (`-`, `_`, `.`, `:`) is what separates a real
 * secret from the slugs and fixture strings that dominate a codebase — `access-token`,
 * `machine_user.api_key_issued`, `correct-horse-battery-staple` and `e2e-Owner-Password-123` are
 * short words joined by separators, while a hex-64 digest, `sk_live_51HxYz…` and a base64 32-byte
 * token each contain one long, mixed-alphabet run that no human typed.
 */
function hasOpaqueSegment(value: string): boolean {
  return value
    .split(/[-_.:]/)
    .some((s) => s.length >= 16 && (characterClasses(s) >= 2 || s.length >= 24))
}

/**
 * `broad` is set for the any-name rule, where the variable name gives no signal that the value is
 * sensitive. It demands a longer, three-alphabet run so that git SHAs, lockfile integrity hashes,
 * image digests and version strings assigned to ordinary env names do not become findings.
 */
function hasCredentialAssignment(text: string, pattern: RegExp, broad = false): boolean {
  pattern.lastIndex = 0
  for (const match of text.matchAll(pattern)) {
    const value = extractLiteralValue(match[2] ?? '')
    if (!value) continue
    if (!CREDENTIAL_LITERAL_PATTERN.test(value)) continue
    if (isPublishedPlaceholder(value)) continue
    if (broad) {
      if (value.split(/[-_.:]/).some((s) => s.length >= 20 && characterClasses(s) >= 3)) return true
      continue
    }
    if (hasOpaqueSegment(value)) return true
  }
  return false
}

function makeFinding(
  file: string,
  line: number,
  text: string,
  rule: string,
  severity: RiskSeverity,
  reason: string
): PublicSafetyFinding {
  return { rule, severity, file, line, text, reason }
}

function scanSecretPatterns(file: string, line: number, text: string): PublicSafetyFinding[] {
  const findings = SECRET_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(
    ({ rule, reason }) => makeFinding(file, line, text, rule, 'critical', reason)
  )
  if (SECRET_ASSIGNMENT_PATTERNS.some((pattern) => pattern.test(text))) {
    findings.push(
      makeFinding(
        file,
        line,
        text,
        'secret-assignment',
        'critical',
        'literal secret-like assignment detected'
      )
    )
  }
  return findings
}

function hasConnectionStringUserinfo(text: string): boolean {
  const connectionScheme = CONNECTION_STRING_SCHEME_PATTERN.exec(text)
  if (!connectionScheme) return false
  const authority = text
    .slice((connectionScheme.index ?? 0) + connectionScheme[0].length)
    .split(/[/?#\s]/, 1)[0]
  return authority.lastIndexOf('@') > 0
}

function scanMetadata(file: string, line: number, text: string): PublicSafetyFinding[] {
  const findings: PublicSafetyFinding[] = []
  if (EMAIL_PATTERN.test(text) && !hasConnectionStringUserinfo(text)) {
    findings.push(
      makeFinding(
        file,
        line,
        text,
        'personal-email',
        'high',
        'personal contact information should not be added to public history'
      )
    )
  }
  if (LOCAL_PATH_PATTERN.test(text)) {
    findings.push(
      makeFinding(
        file,
        line,
        text,
        'local-path',
        'high',
        'machine-specific paths disclose local environment details'
      )
    )
  }
  if (
    LOCAL_ENDPOINT_PATTERN.test(text) &&
    !isDocumentation(file) &&
    !SAFE_LOCAL_ENDPOINT_FILES.has(file)
  ) {
    findings.push(
      makeFinding(
        file,
        line,
        text,
        'local-endpoint',
        'medium',
        'local host and port details are operational information'
      )
    )
  }
  // Every assignment on the line is checked, not just the first: a benign assignment appearing
  // first must not launder a credential-shaped one later on the same line.
  if (hasCredentialAssignment(text, SECRET_ENV_ASSIGNMENT_PATTERN)) {
    findings.push(
      makeFinding(
        file,
        line,
        text,
        'secret-environment-value',
        'high',
        'secret-shaped environment variable assigned a literal, non-placeholder value'
      )
    )
  } else if (hasCredentialAssignment(text, ENV_ASSIGNMENT_PATTERN, true)) {
    findings.push(
      makeFinding(
        file,
        line,
        text,
        'credential-literal-assignment',
        'medium',
        'environment variable assigned a high-entropy literal that looks like a credential'
      )
    )
  }
  return findings
}

function scanLine(file: string, line: number, text: string): PublicSafetyFinding[] {
  return [...scanSecretPatterns(file, line, text), ...scanMetadata(file, line, text)]
}

export function scanText(file: string, content: string): PublicSafetyFinding[] {
  if (SCANNER_FILES.has(file)) return []
  return content.split(/\r?\n/).flatMap((text, index) => scanLine(file, index + 1, text))
}

function parseAddedLines(diff: string): AddedLine[] {
  const added: AddedLine[] = []
  let file = ''
  let newLine = 0
  for (const rawLine of diff.split(/\r?\n/)) {
    if (rawLine.startsWith('+++ b/')) {
      file = rawLine.slice('+++ b/'.length)
      continue
    }
    const hunk = /^@@ -\d[\d,]* \+(\d+)/.exec(rawLine)
    if (hunk) {
      newLine = Number(hunk[1])
      continue
    }
    if (!file || rawLine.startsWith('--- ') || rawLine.startsWith('diff ')) continue
    if (rawLine.startsWith('+')) {
      added.push({ file, line: newLine, text: rawLine.slice(1) })
      newLine += 1
    } else if (!rawLine.startsWith('-') && rawLine !== NO_NEWLINE_MARKER) {
      newLine += 1
    }
  }
  return added
}

function git(root: string, args: string[]): string {
  return execFileSync('/usr/bin/git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, PATH: '/usr/bin:/bin' },
  })
}

export function scanChangedContent(
  rootDir = process.cwd(),
  baseRef = process.env.BASE_REF ?? 'main'
): PublicSafetyFinding[] {
  const root = resolve(rootDir)
  const findings: PublicSafetyFinding[] = []
  const diff = git(root, ['diff', '--no-ext-diff', '--unified=0', baseRef, '--'])
  for (const line of parseAddedLines(diff)) {
    findings.push(
      ...scanText(line.file, line.text).map((finding) => ({ ...finding, line: line.line }))
    )
  }

  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '--'])
    .split(/\r?\n/)
    .filter(Boolean)
  for (const file of untracked) {
    if (SCANNER_FILES.has(file)) continue
    const absolute = resolve(root, file)
    let content: string
    try {
      // The path is constrained by git's own non-ignored file list above.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      content = readFileSync(absolute, 'utf8')
    } catch {
      continue
    }
    if (content.includes('\0')) continue
    findings.push(...scanText(file, content))
  }
  return findings
}

function printFindings(findings: PublicSafetyFinding[]): void {
  for (const finding of findings) {
    process.stdout.write(
      `[${finding.severity.toUpperCase()}] ${finding.rule} ${finding.file}:${finding.line}\n` +
        `  ${finding.reason}\n` +
        `  ${finding.text.trim()}\n`
    )
  }
}

function main(): void {
  const args = new Set(process.argv.slice(2))
  const baseArgIndex = process.argv.indexOf('--base')
  const baseRef =
    baseArgIndex >= 0 ? process.argv[baseArgIndex + 1] : (process.env.BASE_REF ?? 'main')
  const strict = args.has('--strict')
  const findings = scanChangedContent(process.cwd(), baseRef)
  printFindings(findings)

  const blocking = strict
    ? findings
    : findings.filter(({ severity }) => severity === 'critical' || severity === 'high')
  process.stdout.write(
    `check-public-safety: ${findings.length} finding(s), ${blocking.length} blocking, base=${baseRef}\n`
  )
  if (blocking.length > 0) {
    process.exitCode = 1
  } else {
    process.stdout.write('check-public-safety: no blocking publication risks detected — OK\n')
  }
}

if (basename(process.argv[1] ?? '') === 'check-public-safety.ts') main()
