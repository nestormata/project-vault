/**
 * Story 16.2 AC-2/AC-6 — shared, app-wide reactive theme state, mirroring
 * `notifications.svelte.ts`'s `unreadCount` rune pattern: `(app)/+layout.server.ts` resolves the
 * initial `appliedTheme` from the DB on every load (never cached in the session/JWT, AC-6), the
 * root layout seeds this rune from that server data, and `(app)/settings/themes/`'s page updates
 * it directly (pessimistically, only after a successful PATCH response — AC-2's pessimistic-UI
 * requirement) so every part of the already-mounted app re-renders with the new theme
 * immediately, with no navigation and no full-page reload.
 */
let appliedTheme = $state<string | null>(null)

export function getAppliedTheme(): string | null {
  return appliedTheme
}

export function setInitialAppliedTheme(themeName: string | null): void {
  appliedTheme = themeName
}

export function setAppliedTheme(themeName: string | null): void {
  appliedTheme = themeName
}

/**
 * Story 16.4 Task 7.2 — small, deliberate extension for the pre-auth login screen. The `(app)`
 * layout above gets its theme CSS from a server `load()` (`themeCss`, delivered SSR alongside
 * `appliedTheme`) — there is no equivalent server load for the `(auth)` layout (a themeable
 * pre-auth org isn't resolvable until the domain-lookup response arrives client-side, AC-3), so
 * CSS must arrive from that response instead and be carried in its own piece of rune state,
 * distinct from `appliedTheme`/no `themeCss` counterpart above. Deliberately NOT reusing
 * `setAppliedTheme`/`appliedTheme` for this — those are seeded from the authenticated (app)
 * layout's SSR load and must never be silently overwritten by an unauthenticated, client-only
 * domain-lookup response reactivity.
 */
let preAuthThemeName = $state<string | null>(null)
let preAuthThemeCss = $state<string | null>(null)

export function getPreAuthThemeName(): string | null {
  return preAuthThemeName
}

export function getPreAuthThemeCss(): string | null {
  return preAuthThemeCss
}

export function setPreAuthTheme(themeName: string | null, css: string | null): void {
  preAuthThemeName = themeName
  preAuthThemeCss = css
}

/**
 * Story 16.6 AC-1/AC-2/AC-3/AC-4 — a `localStorage`-backed cache of "the last pre-auth theme this
 * browser successfully resolved", written through from `resolvePreAuthTheme()`
 * (`apps/web/src/lib/components/auth/form-model.ts`) and read once, optimistically, on
 * `(auth)/+layout.svelte` mount (Task 3). Deliberately versioned (`v1`) so a future format change
 * ships as a new key rather than a migration — see Dev Notes "Design rationale".
 */
export const PRE_AUTH_THEME_CACHE_KEY = 'pv:preAuthTheme:v1'
export const PRE_AUTH_THEME_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

// Deliberately unambiguous, short deny-list — a defense-in-depth backstop for an
// already-tampered/compromised browser replaying a `localStorage` entry, NOT a reuse of
// Story 16.1's server-only `validateAndCompileTokens` (Node-only dependencies; cannot run in
// `apps/web` — see Dev Notes "Pre-mortem" correction and Task 1.3).
const UNSAFE_CSS_SUBSTRINGS = ['expression(', '@import', 'javascript:', '<script', 'behavior:']
const CSS_URL_FUNCTION_START = /url\(/gi
const CSS_URL_FUNCTION = /url\(([^)]*)\)/gi

function parseCssUrlReference(rawReference: string): string | null {
  const reference = rawReference.trim()
  if (!reference) return ''

  const openingQuote = reference[0]
  if (openingQuote !== '"' && openingQuote !== "'") {
    return reference.includes('"') || reference.includes("'") ? null : reference
  }

  if (reference.at(-1) !== openingQuote) return null
  return reference.slice(1, -1).trim()
}

/**
 * AC-2 security edge case: rejects a cached CSS string containing any deny-listed construct, or a
 * `url(...)` reference that isn't `data:` or `https:`. This is intentionally narrower than the
 * server's full token-grammar validator — it bounds blast radius, it does not re-prove safety.
 */
export function isSafeCachedThemeCss(css: string): boolean {
  const lower = css.toLowerCase()
  if (UNSAFE_CSS_SUBSTRINGS.some((construct) => lower.includes(construct))) {
    return false
  }

  const urlStarts = [...css.matchAll(CSS_URL_FUNCTION_START)]
  const urlFunctions = [...css.matchAll(CSS_URL_FUNCTION)]
  if (urlStarts.length !== urlFunctions.length) return false

  for (const match of urlFunctions) {
    const parsedReference = parseCssUrlReference(match[1] ?? '')
    if (parsedReference === null) return false
    const reference = parsedReference.toLowerCase()
    if (!reference.startsWith('data:') && !reference.startsWith('https://')) {
      return false
    }
  }

  return true
}

/**
 * AC-1: persists a successful (non-null) theme resolution. Only ever called by the caller
 * (`resolvePreAuthTheme`) on a hit — never on a miss (AC-3). Silently swallows any thrown error
 * (private/incognito storage disabled, quota exceeded) so a resolution never fails because the
 * cache write did.
 */
export function writePreAuthThemeCache(name: string, css: string): void {
  try {
    localStorage.setItem(
      PRE_AUTH_THEME_CACHE_KEY,
      JSON.stringify({ name, css, savedAt: Date.now() })
    )
  } catch {
    // AC-1 storage-unavailable edge case: never let a persistence failure surface to the user
    // or block the in-memory theme resolution from applying.
  }
}

function removeCachedTheme(): null {
  try {
    localStorage.removeItem(PRE_AUTH_THEME_CACHE_KEY)
  } catch {
    // Best-effort cleanup only; nothing else to do if storage is unavailable.
  }
  return null
}

type ParsedThemeCacheEntry = { name: string; css: string; savedAt: number }

function isThemeCacheEntryShape(value: unknown): value is ParsedThemeCacheEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).name === 'string' &&
    typeof (value as Record<string, unknown>).css === 'string' &&
    typeof (value as Record<string, unknown>).savedAt === 'number'
  )
}

/**
 * AC-2/AC-3/AC-4: reads and validates the cached entry. Returns `null` (and proactively removes
 * the key) for every invalid case — missing, unparsable, malformed shape, expired past the 7-day
 * TTL, or CSS that fails `isSafeCachedThemeCss`. A future `savedAt` (clock skew) is treated as NOT
 * expired, per AC-4's documented intentional behavior.
 */
export function readPreAuthThemeCache(): { name: string; css: string } | null {
  let raw: string | null
  try {
    raw = localStorage.getItem(PRE_AUTH_THEME_CACHE_KEY)
  } catch {
    return null
  }
  if (!raw) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return removeCachedTheme()
  }

  if (!isThemeCacheEntryShape(parsed)) {
    return removeCachedTheme()
  }

  const { name, css, savedAt } = parsed

  if (Date.now() - savedAt >= PRE_AUTH_THEME_CACHE_TTL_MS) {
    return removeCachedTheme()
  }

  if (!isSafeCachedThemeCss(css)) {
    return removeCachedTheme()
  }

  return { name, css }
}

/**
 * AC-2/AC-9 Task 3.1: called once on `(auth)/+layout.svelte` mount. No-op unless both pre-auth
 * theme runes are still at their default `null` — guards against a race where a page-level
 * resolution already completed (and must always win) before this seed call runs.
 */
export function seedPreAuthThemeFromCache(): void {
  if (preAuthThemeName !== null || preAuthThemeCss !== null) {
    return
  }
  const cached = readPreAuthThemeCache()
  if (cached) {
    setPreAuthTheme(cached.name, cached.css)
  }
}
