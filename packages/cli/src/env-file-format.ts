/**
 * Story 43.5 Dev Notes decision #1 — the `.env` serialization format (Grounding finding G1:
 * `packages/vault-action` has no `.env` quoting/escaping rules to reuse, so this module defines
 * them). Pure: no I/O, no CLI imports. Shared home for any future consumer of the same wire format
 * (Story 43.4's `--secrets-fd` reader, Epic 50's `write_env_file`).
 *
 * Two formats, each targeting ONE named consumer, and each failing closed on any value it cannot
 * represent losslessly (G2 — silent corruption of a secret is never acceptable):
 *
 * - `dotenv` targets Node's built-in `--env-file` parser. Per-value quoting ladder, first match wins:
 *   1. no `'`  → `KEY='value'`   (fully literal in Node and in POSIX shells)
 *   2. no `` ` `` → ``KEY=`value` `` (fully literal in Node; NOT shell-safe)
 *   3. no `"`, no real newline, no two-char `\n`/`\r` → `KEY="value"` (Node only expands `\n`)
 *   4. otherwise → refuse.
 *   A CR (Node silently strips it) or NUL always refuses.
 * - `shell` targets POSIX `sh`/`bash` `source`: `export KEY='value'` with `'` encoded as `'\''`.
 *   Lossless for everything except NUL.
 */
import { isValidEnvVarIdentifier } from './reserved-env-vars.js'

export type EnvFileFormat = 'dotenv' | 'shell'
export const ENV_FILE_FORMATS: readonly EnvFileFormat[] = ['dotenv', 'shell']

export type EnvFileEntry = { key: string; value: string }

export type RefusalReason = 'nul' | 'carriage_return' | 'unrepresentable'

export type SerializeEnvFileResult =
  | { ok: true; text: string; dotenvOnlyQuotedKeys: string[] }
  | { ok: false; key: string; reason: RefusalReason }

/** AC-6 — deterministic (no timestamp) and a comment in both Node's and bash's grammar. */
export const ENV_FILE_HEADER =
  '# Written by pvault write-env. Contains secrets: do not commit, do not share.\n'

const REFUSAL_MESSAGES: Readonly<Record<RefusalReason, string>> = {
  nul: 'contains a NUL byte, which cannot be stored in an environment variable',
  carriage_return: "contains a carriage return, which Node's --env-file parser silently drops",
  unrepresentable:
    'contains characters no dotenv quoting style can represent losslessly; use --format shell',
}

/** The reason class only — never the value or the offending substring (AC-2/AC-5). */
export function refusalMessage(reason: RefusalReason): string {
  return REFUSAL_MESSAGES[reason]
}

type Quoted = { ok: true; text: string; dotenvOnly: boolean } | { ok: false; reason: RefusalReason }

function quoteDotenv(value: string): Quoted {
  if (value.includes('\r')) return { ok: false, reason: 'carriage_return' }
  if (!value.includes("'")) return { ok: true, text: `'${value}'`, dotenvOnly: false }
  if (!value.includes('`')) return { ok: true, text: `\`${value}\``, dotenvOnly: true }
  const doubleQuoteSafe = !value.includes('"') && !value.includes('\n') && !/\\[nr]/.test(value)
  if (doubleQuoteSafe) return { ok: true, text: `"${value}"`, dotenvOnly: true }
  return { ok: false, reason: 'unrepresentable' }
}

/**
 * Serializes `entries` in order. Every value is checked before any text is returned, so a caller
 * that writes only on `ok: true` never writes a partial file.
 */
export function serializeEnvFile(
  entries: EnvFileEntry[],
  format: EnvFileFormat
): SerializeEnvFileResult {
  const lines: string[] = [ENV_FILE_HEADER]
  const dotenvOnlyQuotedKeys: string[] = []

  for (const { key, value } of entries) {
    // Defensive: callers only pass names that already passed the same check. A malformed key is
    // a programmer error, never something to write.
    if (!isValidEnvVarIdentifier(key)) {
      throw new Error(`serializeEnvFile: invalid environment variable name`)
    }
    if (value.includes('\0')) return { ok: false, key, reason: 'nul' }

    if (format === 'shell') {
      lines.push(`export ${key}='${value.replaceAll("'", String.raw`'\''`)}'\n`)
      continue
    }

    const quoted = quoteDotenv(value)
    if (!quoted.ok) return { ok: false, key, reason: quoted.reason }
    if (quoted.dotenvOnly) dotenvOnlyQuotedKeys.push(key)
    lines.push(`${key}=${quoted.text}\n`)
  }

  return { ok: true, text: lines.join(''), dotenvOnlyQuotedKeys }
}

const DOTENV_ASSIGNMENT = /^([A-Za-z_]\w*)=(['`"])/
const SHELL_ASSIGNMENT = /^export ([A-Za-z_]\w*)=/

function parseError(offset: number): Error {
  return new Error(`parseEnvFile: unexpected content at offset ${offset}`)
}

/** Reads a `'…'` run (possibly followed by `\''…'` continuations) starting at `start`. */
function readShellValue(text: string, start: number): { value: string; end: number } {
  let pos = start
  let value = ''
  for (;;) {
    if (text[pos] !== "'") throw parseError(pos)
    const close = text.indexOf("'", pos + 1)
    if (close === -1) throw parseError(pos)
    value += text.slice(pos + 1, close)
    pos = close + 1
    if (!text.startsWith(String.raw`\'`, pos)) return { value, end: pos }
    value += "'"
    pos += 2
  }
}

/** The serializer never emits a value containing its own delimiter (nor, for `"`, a `\n` escape),
 * so the first matching delimiter always closes the value. */
function readDotenvValue(
  text: string,
  start: number,
  quote: string
): { value: string; end: number } {
  const close = text.indexOf(quote, start)
  if (close === -1) throw parseError(start)
  return { value: text.slice(start, close), end: close + 1 }
}

/**
 * Story 43.5 A3 — the reference inverse of `serializeEnvFile`'s OWN output only (header comment,
 * blank lines, and the exact assignment shapes above). Any other line shape throws. This is NOT a
 * general dotenv parser; real-consumer compatibility is proven by the Node/bash oracle tests.
 */
export function parseEnvFile(text: string, format: EnvFileFormat): EnvFileEntry[] {
  const entries: EnvFileEntry[] = []
  let pos = 0
  while (pos < text.length) {
    const lineEnd = text.indexOf('\n', pos)
    const line = text.slice(pos, lineEnd === -1 ? text.length : lineEnd)
    if (line === '' || line.startsWith('#')) {
      pos += line.length + 1
      continue
    }

    const { key, value, end } = parseAssignment(text, pos, format)
    if (end < text.length && text[end] !== '\n') throw parseError(end)
    entries.push({ key, value })
    pos = end + 1
  }
  return entries
}

/** Parses one `KEY=<quoted>` (dotenv) or `export KEY='…'` (shell) assignment starting at `pos`. */
function parseAssignment(
  text: string,
  pos: number,
  format: EnvFileFormat
): { key: string; value: string; end: number } {
  const rest = text.slice(pos)
  const match = (format === 'shell' ? SHELL_ASSIGNMENT : DOTENV_ASSIGNMENT).exec(rest)
  if (!match) throw parseError(pos)
  const key = match[1] as string
  const valueStart = pos + match[0].length
  const parsed =
    format === 'shell'
      ? readShellValue(text, valueStart)
      : readDotenvValue(text, valueStart, match[2] as string)
  return { key, ...parsed }
}
