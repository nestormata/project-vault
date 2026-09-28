/**
 * Story 43.13 (AC-1) — the single definition of the "terminal-unsafe" character set U: every
 * character that must never reach an operator's terminal or the audit trail from an untrusted
 * source, because it can inject escape sequences or visually reorder / hide text.
 *
 * This is the intended single source for every consumer: `pvault`'s `sanitizeForTerminal`
 * (identifier text) and `sanitizeServerText` (free text), the agent's own `encodeTargetCommand`
 * (the `x-vault-target-command` audit header), and Epic 50's broker-rendered text. The API cannot
 * import this package; its `x-vault-target-command` schema check in
 * `apps/api/src/modules/machine-users/machine-credential-schema.ts` duplicates the set on purpose
 * and is tied to it by a parity test.
 *
 * U = C0/C1 controls (incl. ESC → no ANSI/OSC injection, and `\n`/`\t`), bidi controls and marks,
 * zero-width characters, the line/paragraph separators U+2028/U+2029 (so identifier text can never
 * fake a line break, matching how C0 `\n` is treated), word joiner and BOM, every other Unicode
 * format character (\p{Cf}: e.g. U+061C, U+00AD, U+2061-U+2064, U+206A-U+206F), and the whole tag
 * block U+E0000-U+E007F (U+E0000 itself is unassigned, so \p{Cf} alone would miss it).
 *
 * The tag block is checked by code point rather than inside the regex: an astral range such as
 * `\u{E0000}-\u{E007F}` is only valid with the `u` flag, and static ReDoS analysers that re-parse
 * the literal without its flags reject it as unparseable. Consequently `TERMINAL_UNSAFE_CHARACTERS`
 * on its own is NOT the whole of U (it misses the unassigned tag-block code points, e.g. U+E0000,
 * U+E0002-U+E001F) and has no `g` flag (so `.test()` stays stateless): consumers must call
 * `isTerminalUnsafeCharacter` / `stripTerminalUnsafeCharacters`, never the regex directly.
 */
export const TERMINAL_UNSAFE_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u200B-\u200F\u202A-\u202E\u2028\u2029\u2060\u2066-\u2069\uFEFF\p{Cf}]/u

const TAG_BLOCK_FIRST = 0xe0000
const TAG_BLOCK_LAST = 0xe007f

/** True when `char` (one code point, or one lone surrogate) is in U. Pure, never throws. */
export function isTerminalUnsafeCharacter(char: string): boolean {
  const codePoint = char.codePointAt(0)
  if (codePoint === undefined) return false
  if (codePoint >= TAG_BLOCK_FIRST && codePoint <= TAG_BLOCK_LAST) return true
  return TERMINAL_UNSAFE_CHARACTERS.test(char)
}

/** Removes every character in U. Pure, never throws, never truncates; lone surrogates pass through. */
export function stripTerminalUnsafeCharacters(value: string): string {
  let result = ''
  for (const char of value) {
    if (!isTerminalUnsafeCharacter(char)) result += char
  }
  return result
}
