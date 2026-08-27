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
const SECRET_ENV_NAME_PATTERN =
  /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY)[A-Z0-9_]*\b/
// These names are public deployment interfaces; their values are still scanned for credentials.
// Keep this allowlist exact so unknown secret-like names remain review findings.
const SAFE_PUBLIC_CONSTANT_NAMES = new Set([
  'ADMIN_PG_PASSWORD',
  'DEMO_LOGIN_PASSWORD',
  'FLY_DEMO_VAULT_ADMIN_PASSWORD',
  'FLY_DEMO_VAULT_APP_PASSWORD',
  'MAX_FIELDS_PER_SECRET',
  'PGPASSWORD',
  'VAULT_ADMIN_PASSWORD',
  'VAULT_APP_PASSWORD',
  // Story 23.11: a plain numeric TTL constant, not a credential value. Identical in name and
  // value to the pre-existing `TEST_ACCESS_TOKEN_TTL_SECONDS` in
  // apps/api/src/__tests__/secure-route.integration.test.ts (which the checker doesn't flag
  // because those lines aren't new relative to `main`). New test files reproduce this
  // established naming convention as a "new" finding only because the checker scans added
  // lines, not full-file content.
  'TEST_ACCESS_TOKEN_TTL_SECONDS',
  // Story 25.4: `THEME_TOKENS` (packages/shared/src/constants/theme-tokens.ts) is the
  // pre-existing public theme-token registry name (colors/lengths/enum tokens, no credential
  // material) — it only trips this checker because a new file's doc comment references it by
  // name and the checker scans added lines, not full-file content.
  'THEME_TOKENS',
  // Story 25.6: local test-fixture constant names, not real secret values. `DEFAULT_CSRF_TOKEN`
  // is a literal test string asserting the CSRF double-submit-cookie check's own behavior;
  // `OPAQUE_REFRESH_TOKEN` is `tokens.test.ts`'s existing fixture name for a fake refresh-token
  // value, unrelated to this story's own change (only trips this checker because the new CSRF
  // assertions in that file made the surrounding lines "added" relative to `main`).
  'DEFAULT_CSRF_TOKEN',
  'OPAQUE_REFRESH_TOKEN',
  // Story 20.8: `ephemeral-state.integration.test.ts` fixture key names used to exercise
  // `HostServices.ephemeralState`'s per-org isolation and compare-and-swap/delete semantics —
  // they name the *test's own arbitrary storage key*, not a real credential value.
  'PAIRING_TOKEN_KEY',
  'PENDING_TOKEN_KEY',
])
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
  // Trips this rule only because the whole file is new, reproducing an already-repo-wide pattern.
  'docs/runbooks/module-pack-lifecycle.md',
])

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
  if (LOCAL_ENDPOINT_PATTERN.test(text) && !SAFE_LOCAL_ENDPOINT_FILES.has(file)) {
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
  const secretName = SECRET_ENV_NAME_PATTERN.exec(text)?.[0]
  if (secretName && !SAFE_PUBLIC_CONSTANT_NAMES.has(secretName)) {
    findings.push(
      makeFinding(
        file,
        line,
        text,
        'secret-environment-name',
        'medium',
        'secret-like environment variable names reveal operational conventions'
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
