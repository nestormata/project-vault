import { stripTerminalUnsafeCharacters } from '@project-vault/agent'

/**
 * Story 43.6 (decision D6), unified by Story 43.13 — renders **free text** (server-supplied prose
 * such as a withdrawal reason or an error message, or a library's `Error.message`) for the
 * terminal. It removes exactly the same character set as `sanitizeForTerminal` (the terminal-unsafe
 * set U, defined once in `@project-vault/agent`'s `terminal-unsafe-characters.ts`); what remains
 * different is free-text shaping: line/paragraph breaks become spaces (before U is removed, so
 * "line1\nline2" reads as "line1 line2" instead of gluing the words), runs of spaces collapse, the
 * result is trimmed, and it is truncated by code point with a trailing "…".
 */

// Line-breaking characters become a space so "line1\nline2" reads as "line1 line2". Must run
// before U is stripped: U contains every one of these.
const LINE_BREAKS = /[\t\n\v\f\r\u2028\u2029]/g
const WHITESPACE_RUNS = / {2,}/g

export const SERVER_TEXT_MAX_CODE_POINTS = 200

/**
 * Story 43.13 AC-2 — cap for server / library error prose printed by `pvault`. Longer than the
 * 200 used for reasons (Node network and TLS errors run to ~150-250 characters) but still bounded,
 * so a hostile server cannot flood the terminal.
 */
export const ERROR_TEXT_MAX_CODE_POINTS = 500

export function sanitizeServerText(
  value: string,
  maxCodePoints: number = SERVER_TEXT_MAX_CODE_POINTS
): string {
  const cleaned = stripTerminalUnsafeCharacters(value.replaceAll(LINE_BREAKS, ' '))
    .replaceAll(WHITESPACE_RUNS, ' ')
    .trim()
  const codePoints = [...cleaned]
  if (codePoints.length <= maxCodePoints) return cleaned
  return `${codePoints.slice(0, maxCodePoints - 1).join('')}…`
}
