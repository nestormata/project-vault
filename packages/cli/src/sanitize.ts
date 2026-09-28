import { stripTerminalUnsafeCharacters } from '@project-vault/agent'

/**
 * Renders **identifier text** (a credential name, project id, file path, command, env-var name or
 * error code) for the terminal. Such a value can originate from an external, less-trusted source (a
 * templated CI variable, a generated manifest, a name the server echoes back) and error messages
 * echo it verbatim, so it must never be able to manipulate the invoking terminal, fake multi-line
 * output or visually reorder what the operator reads.
 *
 * Story 43.13 (supersedes 43.6 D6's "unchanged" decision): strips the whole terminal-unsafe set U
 * defined once in `@project-vault/agent` (`terminal-unsafe-characters.ts`) — C0/C1 controls
 * (including ESC, so every ANSI/CSI/OSC sequence becomes inert), newlines and tabs, bidi controls
 * and marks, zero-width and every other Unicode format character, and the tag block. It shares that
 * character set with `sanitizeServerText`; the two differ only in shaping: an identifier is never
 * truncated and its whitespace is never collapsed, and line breaks / tabs are **removed** (not turned
 * into spaces) so a name stays one token. Never applied to a fetched secret value.
 */
export function sanitizeForTerminal(value: string): string {
  return stripTerminalUnsafeCharacters(value)
}
