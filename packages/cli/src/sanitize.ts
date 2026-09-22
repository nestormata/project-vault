/**
 * AC-5 edge case (terminal escape-sequence injection, Security Audit Personas 2026-09-22) — a
 * credential `name` can originate from an external, less-trusted source (a templated CI variable,
 * a generated manifest) and every error message echoes it back verbatim. Strips C0/C1 control
 * characters (including ESC, and therefore every ANSI/CSI escape sequence that starts with it)
 * plus newlines/tabs, so a hostile name can never manipulate the invoking terminal or fake
 * multi-line output when interpolated into a stderr message. Never applied to the fetched secret
 * value itself — only to the attacker-influenceable `name` input.
 */
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g

export function sanitizeForTerminal(value: string): string {
  return value.replace(CONTROL_CHARS, '')
}
