// Story 62-6 — the shared rule behind the `raw-fetch` guard: authenticated API helpers must not
// call the injected `fetchFn` directly (that skips the 61-3 session-refresh contract). The only
// direct calls allowed are `api/client.ts` itself and the reviewed exclusions below, each a
// session-less endpoint with a reason. Adding an entry is a reviewed code change, never a quiet
// allowlist: an authenticated endpoint must use apiFetch / apiFetchBody / fetchResponseWithRefresh.

export interface RawFetchExclusion {
  /** File name inside `src/lib/api/`. */
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
const CALL = /(?<![\w.$])(?:fetchFn|fetch)\(\s*([^,)\n]+)/g

export const RAW_FETCH_HINT =
  'use apiFetch / apiFetchBody / fetchResponseWithRefresh from api/client.ts so the call follows the session-refresh contract; only session-less endpoints belong in RAW_FETCH_EXCLUSIONS'

/** `sources` maps a file name in `src/lib/api/` (non-test) to its text. */
export function rawFetchProblems(
  sources: Record<string, string>,
  exclusions: readonly RawFetchExclusion[] = RAW_FETCH_EXCLUSIONS
): string[] {
  const problems: string[] = []
  const used = new Set<RawFetchExclusion>()
  for (const [file, text] of Object.entries(sources)) {
    if (file === CLIENT_FILE) continue
    for (const match of text.matchAll(CALL)) {
      const target = (match[1] ?? '').trim()
      const entry = exclusions.find((e) => e.file === file && e.target === target)
      if (entry) used.add(entry)
      else
        problems.push(
          `${file}: raw fetch call to ${target} bypasses the session refresh: ${RAW_FETCH_HINT}`
        )
    }
  }
  for (const entry of exclusions) {
    if (!used.has(entry)) {
      problems.push(`stale exclusion: ${entry.file} no longer calls fetch with ${entry.target}`)
    }
  }
  return problems
}
