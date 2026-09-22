// Story 43.1 AC-2 boundary case — ported from packages/vault-action/src/classify.ts's
// looksLikeUuid() (reuse the pattern, don't reinvent it) so the CLI catches a typo'd project
// *display name* client-side before it's ever sent to the server as a `:projectId` route segment.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function looksLikeUuid(value: string): boolean {
  return UUID_REGEX.test(value)
}

/** AC-2 boundary case — an empty or whitespace-only credential name must be rejected locally,
 * before any network call, rather than sent through to packages/agent. */
export function isBlank(value: string): boolean {
  return value.trim().length === 0
}
