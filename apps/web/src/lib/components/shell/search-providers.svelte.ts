// Story 72.18 (CM request R3): the GlobalSearch results-provider seam.
//
// A host that searches its own data (CentralizeMe: tenants, groups, billing) contributes extra
// palette results through a PROVIDER instead of replacing the whole palette. A provider is trusted
// first-party code (ADR 0007): the seam adds no sanitizer, allowlist or capability boundary beyond
// what applies to PV's own UI. Nothing here changes the native results, their ordering or the
// keyboard behaviour; provider results are only ever appended after them.
//
// Registration goes through the component tree, not module state: `AppLayoutSearch` provides a
// registry in context, and a fill of the `app.layout.search` injection point (rendered inside it)
// calls `registerSearchProvider(...)` from its script. Context keeps one registry per mounted
// layout, so nothing leaks between server requests, and registration happens in `onMount`, so a
// provider never runs during SSR.
import { getContext, onMount, setContext } from 'svelte'
import type { ResolvedPathname } from '$app/types'

/**
 * What a provider answers with. Exactly one of `href` and `action` is set. `href` is an app path
 * produced by SvelteKit's `resolve()` (the same typing the navigation data uses, so the lint rule
 * `svelte/no-navigation-without-resolve` can verify it by type); anything else, such as an external
 * URL, goes through `action`.
 */
export type SearchProviderResult = {
  /** Stable within the provider; keys the row. */
  id: string
  label: string
  /** Optional second line (a type, a path). */
  hint?: string
  /** The group heading the row sits under. */
  group: string
} & (
  | { href: ResolvedPathname; action?: undefined }
  | { action: () => void | Promise<void>; href?: undefined }
)

export interface SearchProvider {
  /** Unique per registry; registering the same id again replaces the earlier provider. */
  id: string
  /**
   * Answers one query. The signal aborts when the query is superseded, the palette closes or the
   * timeout passes; a provider that ignores it is still cut off at the timeout.
   */
  search: (
    query: string,
    context: { signal: AbortSignal }
  ) => Promise<readonly SearchProviderResult[]>
  /** Per-query time limit; defaults to {@link DEFAULT_PROVIDER_TIMEOUT_MS}. */
  timeoutMs?: number
}

export type ProviderOutcome =
  { status: 'ok'; results: SearchProviderResult[] } | { status: 'failed' } | { status: 'aborted' }

export const DEFAULT_PROVIDER_TIMEOUT_MS = 3000

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isValidResult(value: unknown): value is SearchProviderResult {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (!isNonEmptyString(candidate.id) || !isNonEmptyString(candidate.label)) return false
  if (!isNonEmptyString(candidate.group)) return false
  if (candidate.hint !== undefined && typeof candidate.hint !== 'string') return false
  const hasHref = isNonEmptyString(candidate.href)
  const hasAction = typeof candidate.action === 'function'
  return hasHref !== hasAction
}

/**
 * Runs one provider for one query. Never rejects: a throw, a rejection, a malformed answer and a
 * timeout are all `failed`; a superseded query is `aborted` so the caller can drop the outcome.
 */
export function runSearchProvider(
  provider: SearchProvider,
  query: string,
  querySignal: AbortSignal
): Promise<ProviderOutcome> {
  if (querySignal.aborted) return Promise.resolve({ status: 'aborted' })
  return new Promise<ProviderOutcome>((resolve) => {
    const controller = new AbortController()
    const finish = (outcome: ProviderOutcome) => {
      clearTimeout(timer)
      querySignal.removeEventListener('abort', onQueryAbort)
      if (!controller.signal.aborted) controller.abort()
      resolve(outcome)
    }
    const onQueryAbort = () => finish({ status: 'aborted' })
    const timer = setTimeout(
      () => finish({ status: 'failed' }),
      provider.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS
    )
    querySignal.addEventListener('abort', onQueryAbort, { once: true })
    const settle = (answer: unknown) => {
      if (!Array.isArray(answer)) finish({ status: 'failed' })
      else finish({ status: 'ok', results: answer.filter(isValidResult) })
    }
    try {
      provider.search(query, { signal: controller.signal }).then(settle, () => {
        finish({ status: 'failed' })
      })
    } catch {
      finish({ status: 'failed' })
    }
  })
}

export interface SearchProviderRegistry {
  /** Registered providers, in registration order. Reactive. */
  readonly providers: readonly SearchProvider[]
  /** Registers a provider and returns its unregister function. */
  register: (provider: SearchProvider) => () => void
}

export function createSearchProviderRegistry(): SearchProviderRegistry {
  let list = $state.raw<SearchProvider[]>([])
  return {
    get providers() {
      return list
    },
    register(provider) {
      const index = list.findIndex((entry) => entry.id === provider.id)
      list =
        index === -1
          ? [...list, provider]
          : list.map((entry, at) => (at === index ? provider : entry))
      return () => {
        list = list.filter((entry) => entry !== provider)
      }
    },
  }
}

export const SEARCH_PROVIDERS_CONTEXT = Symbol.for('pv.global-search.providers')

/** Called by `AppLayoutSearch` during its init: makes a registry available to its subtree. */
export function provideSearchProviders(): SearchProviderRegistry {
  const registry = createSearchProviderRegistry()
  setContext(SEARCH_PROVIDERS_CONTEXT, registry)
  return registry
}

/** The registry of the nearest `AppLayoutSearch`, or undefined when there is none. */
export function useSearchProviders(): SearchProviderRegistry | undefined {
  return getContext<SearchProviderRegistry | undefined>(SEARCH_PROVIDERS_CONTEXT)
}

/**
 * For a fill of the `app.layout.search` injection point: registers `provider` for as long as the
 * fill is mounted. Call it from the fill's `<script>`. With no palette around it, it does nothing.
 */
export function registerSearchProvider(provider: SearchProvider): void {
  const registry = useSearchProviders()
  onMount(() => registry?.register(provider))
}
