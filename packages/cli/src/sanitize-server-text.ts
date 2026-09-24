/**
 * Story 43.6 (decision D6) — renders server-supplied free text (a withdrawal reason) and other
 * externally-influenced strings in a version-check message. Stricter than `sanitizeForTerminal`
 * (which stays unchanged for credential names): besides C0/C1 controls it also strips Unicode bidi
 * embeddings/overrides/isolates and marks, zero-width characters, and turns line/paragraph
 * separators into spaces, then collapses whitespace and truncates by code point.
 */

// Line-breaking characters become a space so "line1\nline2" reads as "line1 line2".
const LINE_BREAKS = /[\t\n\v\f\r\u2028\u2029]/g
// Remaining C0/C1 controls (incl. ESC → no ANSI/OSC injection), bidi controls and marks,
// zero-width characters, word joiner and BOM are removed outright.
const INVISIBLE_OR_CONTROL =
  /[\u0000-\u001f\u007f-\u009f\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g
const WHITESPACE_RUNS = / {2,}/g

export const SERVER_TEXT_MAX_CODE_POINTS = 200

export function sanitizeServerText(
  value: string,
  maxCodePoints: number = SERVER_TEXT_MAX_CODE_POINTS
): string {
  const cleaned = value
    .replace(LINE_BREAKS, ' ')
    .replace(INVISIBLE_OR_CONTROL, '')
    .replace(WHITESPACE_RUNS, ' ')
    .trim()
  const codePoints = [...cleaned]
  if (codePoints.length <= maxCodePoints) return cleaned
  return `${codePoints.slice(0, maxCodePoints - 1).join('')}…`
}
