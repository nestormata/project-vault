#!/usr/bin/env tsx
/**
 * Story 66.21 — mechanical check for the public-repo "Nestor only, no agent attribution" rule
 * (AGENTS.md, 2026-09-30).
 *
 * Scans commit messages in `<base>..HEAD` (non-merge commits only, so merged history and a branch
 * that merged `main` in are never flagged) plus the PR title and body (`PR_TITLE` / `PR_BODY`;
 * unset or empty means nothing to scan). Fails (exit 1, one line per finding) on:
 *   - a co-author trailer naming an agent or an anthropic address (human co-authors pass);
 *   - a session trailer or any claude.ai/code/session URL;
 *   - a "Generated with ..." footer naming an agent tool.
 * Exits 2 when the commit range cannot be read (unknown base, shallow clone): it never passes
 * silently. File contents are never scanned, so there is no allowlist and nothing to exempt.
 *
 * Usage: tsx scripts/check-no-agent-attribution.ts [--base <ref>]   (default origin/main)
 */
import { pathToFileURL } from 'node:url'
import { trustedGit } from './lib/trusted-executable.js'

export type AttributionFinding = { rule: string; line: string }
export type CheckResult = { code: number; lines: string[] }

const AGENT_NAMES = /claude|anthropic|copilot|codex|openai|gemini|chatgpt|gpt-/i
const FOOTER_TOOLS = /claude|codex|copilot|chatgpt|gemini/i
const CO_AUTHOR_KEY = /^\s*co-?authored-?by\s*:/i
const SESSION_KEY = /^\s*[\w-]*session\s*:/i
const SESSION_URL = /claude\.ai\/code\/session/i
const GENERATED_WITH = /\bgenerated with\b/i
// Zero-width, soft-hyphen and bidi format characters an author could hide inside a keyword,
// as code-point ranges (not a regex literal, which would embed the characters themselves).
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0xfeff, 0xfeff],
]

function isInvisible(char: string): boolean {
  const cp = char.codePointAt(0) ?? 0
  return INVISIBLE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)
}

function normalise(text: string): string {
  return Array.from(text.normalize('NFKC'))
    .filter((c) => !isInvisible(c))
    .join('')
}

function classify(line: string): string[] {
  const rules: string[] = []
  if (CO_AUTHOR_KEY.test(line) && AGENT_NAMES.test(line)) rules.push('agent-co-author')
  if (SESSION_KEY.test(line) && /claude/i.test(line)) rules.push('session-trailer')
  if (SESSION_URL.test(line)) rules.push('session-url')
  if (GENERATED_WITH.test(line) && FOOTER_TOOLS.test(line)) rules.push('generated-with-footer')
  return rules
}

/** Pure scan of one message: every offending line with the rule it broke. */
export function findAttribution(text: string): AttributionFinding[] {
  const findings: AttributionFinding[] = []
  for (const line of normalise(text).split(/\r?\n/)) {
    for (const rule of classify(line)) findings.push({ rule, line: line.trim() })
  }
  return findings
}

function readCommits(cwd: string, base: string): { sha: string; message: string }[] {
  const out = trustedGit(cwd, ['log', '--no-merges', '--format=%H%x00%B%x1e', `${base}..HEAD`])
  return out
    .split('\x1e')
    .map((record) => record.replace(/^\n+/, ''))
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha = '', ...rest] = record.split('\x00')
      return { sha, message: rest.join('\x00') }
    })
}

export function runCheck(options: {
  cwd: string
  base: string
  env: Record<string, string | undefined>
}): CheckResult {
  const lines: string[] = []
  let commits: { sha: string; message: string }[]
  try {
    commits = readCommits(options.cwd, options.base)
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error)
    return {
      code: 2,
      lines: [
        `check-no-agent-attribution: cannot read commits in ${options.base}..HEAD: ${reason}`,
      ],
    }
  }
  for (const { sha, message } of commits) {
    for (const f of findAttribution(message)) lines.push(`commit ${sha}: ${f.rule}: ${f.line}`)
  }
  const prText: [string, string | undefined][] = [
    ['PR title', options.env.PR_TITLE],
    ['PR body', options.env.PR_BODY],
  ]
  for (const [label, text] of prText) {
    if (!text) continue
    for (const f of findAttribution(text)) lines.push(`${label}: ${f.rule}: ${f.line}`)
  }
  return { code: lines.length > 0 ? 1 : 0, lines }
}

function parseBase(argv: string[]): string {
  const index = argv.indexOf('--base')
  return index >= 0 && argv[index + 1] ? (argv[index + 1] as string) : 'origin/main'
}

function main(): void {
  const result = runCheck({
    cwd: process.cwd(),
    base: parseBase(process.argv.slice(2)),
    env: process.env,
  })
  for (const line of result.lines) process.stderr.write(`${line}\n`)
  if (result.code === 0) {
    process.stdout.write('check-no-agent-attribution: no agent attribution found\n')
  } else if (result.code === 1) {
    process.stderr.write(
      'Public-repo commits and PRs list Nestor only (AGENTS.md): remove the attribution lines.\n'
    )
  }
  process.exit(result.code)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
