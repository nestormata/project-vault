// Story 62-6 — the shared rule behind the `raw-fetch` guard: authenticated API helpers must not
// call the injected `fetchFn` directly (that skips the 61-3 session-refresh contract). The only
// direct calls allowed are `api/client.ts` itself and the reviewed exclusions below, each a
// session-less endpoint with a reason. Adding an entry is a reviewed code change, never a quiet
// allowlist: an authenticated endpoint must use apiFetch / apiFetchBody / fetchResponseWithRefresh.

export interface RawFetchExclusion {
  /** Path inside `src/lib/api/` (a bare file name for top-level files, `sub/x.ts` below). */
  file: string
  /** The first argument exactly as written at the call site. */
  target: string
  reason: string
}

const PLATFORM_FILE = 'platform.ts'

export const RAW_FETCH_EXCLUSIONS: readonly RawFetchExclusion[] = [
  { file: 'vault.ts', target: "'/ready'", reason: 'unauthenticated readiness probe' },
  { file: PLATFORM_FILE, target: "'/ready'", reason: 'unauthenticated readiness probe' },
  { file: PLATFORM_FILE, target: "'/api/health'", reason: 'unauthenticated health probe' },
  {
    file: PLATFORM_FILE,
    target: "'/api/v1/openapi.json'",
    reason: 'public OpenAPI document, not session-bound',
  },
  {
    file: PLATFORM_FILE,
    target: 'CLIENT_VERSION_POLICY_PATH',
    reason: 'client-version policy has its own contract (not session-bound)',
  },
]

const CLIENT_FILE = 'client.ts'
// The callee may be reached through the global object (`globalThis.fetch`, `window.fetch`,
// `self.fetch`), optional-called (`fetchFn?.(`), or invoked via call/apply/bind.
const CALL =
  /(?<![\w.$])(?:(?:globalThis|window|self)\.)?(?:fetchFn|fetch)(?:\.(?:call|apply|bind)|\?\.)?\(\s*([^,)\n]+)/g
const REFLECT_APPLY = /Reflect\.apply\(\s*(?:fetchFn|fetch)\b/
// `const f = fetchFn` (or `= globalThis.fetch`) hands the raw function to a name the call regex
// cannot follow; passing `fetchFn` as an argument to apiFetch & co is the only legitimate use.
const ALIAS =
  /(?<![=!<>])=(?!=)\s*(?:(?:globalThis|window|self)\.)?(?:fetchFn|fetch)\b(?![ \t]*[(.$\w])/g

export const RAW_FETCH_HINT =
  'use apiFetch / apiFetchBody / fetchResponseWithRefresh from api/client.ts so the call follows the session-refresh contract; only session-less endpoints belong in RAW_FETCH_EXCLUSIONS'

function bypass(file: string, what: string): string {
  return `${file}: ${what} bypasses the session refresh: ${RAW_FETCH_HINT}`
}

function indirectProblems(file: string, text: string): string[] {
  const problems = [...text.matchAll(ALIAS)].map((m) =>
    bypass(file, `aliasing the raw fetch (${m[0].trim()})`)
  )
  if (REFLECT_APPLY.test(text)) problems.push(bypass(file, 'Reflect.apply on the raw fetch'))
  return problems
}

/** `sources` maps a path in `src/lib/api/` (any depth, non-test) to its text. */
export function rawFetchProblems(
  sources: Record<string, string>,
  exclusions: readonly RawFetchExclusion[] = RAW_FETCH_EXCLUSIONS
): string[] {
  const problems: string[] = []
  const used = new Set<RawFetchExclusion>()
  for (const [file, text] of Object.entries(sources)) {
    if (file === CLIENT_FILE) continue
    problems.push(...indirectProblems(file, text))
    for (const match of text.matchAll(CALL)) {
      const target = (match[1] ?? '').trim()
      const entry = exclusions.find((e) => e.file === file && e.target === target)
      if (entry) used.add(entry)
      else problems.push(bypass(file, `raw fetch call to ${target}`))
    }
  }
  for (const entry of exclusions) {
    if (!used.has(entry)) {
      problems.push(`stale exclusion: ${entry.file} no longer calls fetch with ${entry.target}`)
    }
  }
  return problems
}
