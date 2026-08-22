#!/usr/bin/env tsx
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { toRepoPath, walkFiles } from './lib/scan-utils.js'

export type Violation = { file: string; line: number; text: string }

export const STUB_MARKER_SOURCE_TEXT = ['alert', 'pending_epic3'].join('.')
// Strips every character that isn't a letter/digit/underscore, then checks the
// remaining alphanumeric stream for the marker with its separating dot removed too.
// This collapses far more obfuscation shapes than a punctuation-only strip would —
// not just 'alert' + '.' + 'pending_epic3', but also array/join forms like
// ['alert', 'pending_epic3'].join('.') where the dot is inserted at runtime by
// Array#join and never appears between the two words in the source text at all
// (Red Team: reject split-string obfuscation, not just `+`-concatenation).
const STUB_MARKER_NORMALIZED = STUB_MARKER_SOURCE_TEXT.replaceAll('.', '')
const NORMALIZE_PATTERN = /\W/g
const SCANNABLE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mts', '.cts', '.jsx']

// Normalization is bounded to a single line rather than the whole file: stripping
// punctuation/whitespace across an entire file could merge two unrelated words that
// happen to appear near each other in prose (e.g. separate sentences) into a false
// positive. A single line is still enough to catch the obfuscation shapes AC-13
// cares about (`alert` + `.`/`,`/etc + `pending_epic3`, or an array-join form),
// since none of those constructions span multiple source lines in practice.
function lineContainsMarker(line: string): boolean {
  if (line.includes(STUB_MARKER_SOURCE_TEXT)) return true
  return line.replace(NORMALIZE_PATTERN, '').includes(STUB_MARKER_NORMALIZED)
}

function fileContainsMarker(content: string): boolean {
  return content.split('\n').some((line) => lineContainsMarker(line))
}

function lineForFirstMatch(content: string): number {
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lineContainsMarker(lines[i] ?? '')) return i + 1
  }
  // fileContainsMarker/lineForFirstMatch now use the same per-line check, so this
  // is unreachable when fileContainsMarker(content) is true — kept as a safe
  // fallback rather than a non-null assertion.
  return 1
}

export function scanAlertPendingEpic3(rootDir = process.cwd()): Violation[] {
  const root = resolve(rootDir)
  const scanRoot = resolve(root, 'apps/api/src')
  const violations: Violation[] = []

  for (const file of walkFiles(scanRoot, (path) =>
    SCANNABLE_EXTENSIONS.some((ext) => path.endsWith(ext))
  )) {
    const content = readFileSync(file, 'utf8')
    if (!fileContainsMarker(content)) continue
    violations.push({
      file: toRepoPath(root, file),
      line: lineForFirstMatch(content),
      text: STUB_MARKER_SOURCE_TEXT,
    })
  }

  return violations
}

function report(violations: Violation[]): void {
  if (violations.length === 0) {
    process.stdout.write(
      'check-alert-pending-epic3: no Epic 3 stub alert markers found in apps/api/src — OK\n'
    )
    return
  }

  process.stderr.write(
    `FATAL: retired stub marker "${STUB_MARKER_SOURCE_TEXT}" still present in apps/api/src (Epic 3 gate — see AC-13):\n`
  )
  for (const violation of violations) {
    process.stderr.write(`  - ${violation.file}:${violation.line}\n`)
  }
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  report(scanAlertPendingEpic3())
}
