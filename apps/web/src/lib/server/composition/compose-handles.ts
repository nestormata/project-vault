// Story 68.6 AC-4 (design §8.2) — `composeHandles()` keeps Kit `sequence()`'s observable semantics
// (forward pre-processing, reverse post-processing, innermost-first `transformPageChunk` with
// `?? ''` per step, first-wins `preload`/`filterSerializedResponseHeaders`, event passing,
// short-circuit, resolve-twice, error propagation) WITHOUT Kit's per-request AsyncLocalStorage, so
// PV's `handle` stays directly callable with a hand-built fake event in unit tests.
//
// Documented differences from `sequence()` (pinned by tests, not bugs):
//   (a) no per-handle OpenTelemetry span (`sveltekit.handle.sequenced.*`), design §15;
//   (b) `getRequestEvent()` inside a handle returns the event Kit stored for the whole request,
//       not the per-handle event passed through `resolve(otherEvent)`.
//
// It is also the ONE place that sets the security headers (design rule "one header-setting
// point"): with a `headerPolicy` option it calls `event.setHeaders` exactly once, before the first
// handle runs.
import type { Handle, RequestEvent, ResolveOptions } from '@sveltejs/kit'
import {
  resolveHeaders,
  type HeaderPolicy,
  type HeaderRequest,
} from '$lib/security/header-policy.js'

export interface ComposeHandlesOptions {
  /** The composed app-wide header policy, set once per request before the first handle. */
  headerPolicy?: HeaderPolicy
  /** Headers for requests that are outside the policy (PV: the frozen extension-panel branch).
   * Returns the full header set for such a request, or `null` when the policy applies. */
  outsidePolicy?: (req: HeaderRequest) => Record<string, string> | null
}

type Resolve = Parameters<Handle>[0]['resolve']

export function headerRequestOf(event: RequestEvent): HeaderRequest {
  return { pathname: event.url.pathname, routeId: event.route?.id ?? null }
}

function mergeOptions(
  own: ResolveOptions | undefined,
  parent: ResolveOptions | undefined
): ResolveOptions {
  return {
    transformPageChunk: async ({ html, done }) => {
      let out = html
      if (own?.transformPageChunk) out = (await own.transformPageChunk({ html: out, done })) ?? ''
      if (parent?.transformPageChunk)
        out = (await parent.transformPageChunk({ html: out, done })) ?? ''
      return out
    },
    filterSerializedResponseHeaders:
      parent?.filterSerializedResponseHeaders ?? own?.filterSerializedResponseHeaders,
    preload: parent?.preload ?? own?.preload,
  }
}

async function applyHandle(
  handles: readonly Handle[],
  index: number,
  event: RequestEvent,
  resolve: Resolve,
  parent: ResolveOptions | undefined
): Promise<Response> {
  const handle = handles.at(index) as Handle
  return await handle({
    event,
    resolve: (next: RequestEvent, own?: ResolveOptions): Response | Promise<Response> => {
      const options = mergeOptions(own, parent)
      return index < handles.length - 1
        ? applyHandle(handles, index + 1, next, resolve, options)
        : resolve(next, options)
    },
  })
}

export function composeHandles(
  handles: readonly Handle[],
  options: ComposeHandlesOptions = {}
): Handle {
  const chain = Object.freeze([...handles])
  const { headerPolicy, outsidePolicy } = options
  return ({ event, resolve }) => {
    if (headerPolicy) {
      const req = headerRequestOf(event)
      event.setHeaders(outsidePolicy?.(req) ?? resolveHeaders(headerPolicy, req))
    }
    if (chain.length === 0) return resolve(event)
    return applyHandle(chain, 0, event, resolve, undefined)
  }
}
