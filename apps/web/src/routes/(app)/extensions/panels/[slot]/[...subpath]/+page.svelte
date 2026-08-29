<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { SvelteSet } from 'svelte/reactivity'
  import { renderPanelHtml } from '$lib/security/render-panel-html.js'
  import { EXTENSION_THEME_CSS_VARS } from '$lib/security/extension-theme-vars.js'
  let { data } = $props()

  let heading: HTMLHeadingElement | undefined

  // Story 29.1 AC1/AC9 — the panel's HTML now renders directly into a real, same-origin,
  // same-document `<div>` (via the `renderPanelHtml` action below) instead of into a sandboxed
  // `srcdoc` iframe. `panelIframe` below is a misnomer carried over from Story 25.x — no iframe
  // exists any more, but the postMessage relay code (AC8) still references it (see that code's
  // own comment) pending Stories 29.2/29.4/29.6, which is why the `$state`/type is kept as-is
  // rather than renamed here (a rename would touch every line of that inert relay code for no
  // functional reason, ahead of the stories that are actually replacing it).
  let panelIframe: HTMLIFrameElement | undefined = $state(undefined)

  // Story 25.8 Task 2a — Boundary & Edge Case Sweep finding (Elicitation Log #3): a
  // navigation-triggered `srcdoc` swap tears down the old iframe document and creates a NEW
  // `contentWindow`. Without this, an in-flight action/data-request/navigation-request's
  // response would silently resolve into a stale/detached window with no error ever surfaced —
  // dropped forever, unnoticed. `panelGeneration` is bumped every time the panel's resolved HTML
  // actually changes (see the `$effect` keyed on `data.html` below); every request handler
  // captures the generation at issue time and EXPLICITLY checks it before ever posting a response
  // back or acting on one, so a stale in-flight request is deliberately dropped, not silently
  // left to resolve into nothing. `pendingRequestIds` mirrors which requestIds are currently in
  // flight (added on issue, removed on settle) — cleared on every generation bump, so it also
  // always reflects only the CURRENT panel instance's own in-flight requests.
  //
  // Story 29.1 AC8 — this relay code (this variable included) is now INERT: `postMessage` events
  // can no longer arrive from a same-document `<div>` the way they could from a cross-origin
  // sandboxed iframe's `contentWindow`. Left in place, untouched, pending Stories 29.2 (action
  // relay), 29.4 (data relay), and 29.6 (navigation relay), each of which owns retiring/replacing
  // one of these three relays with a direct same-origin call. Do not delete or "fix" this code
  // here — that is explicitly out of this story's scope.
  let panelGeneration = 0
  const pendingRequestIds = new SvelteSet<string>()

  const PANEL_ACTION_REQUEST_SOURCE = 'pv-extension-panel-action'
  const PANEL_ACTION_RESULT_SOURCE = 'pv-extension-panel-action-result'

  // Story 25.6 AC5 — the double-submit-cookie CSRF token's request-header name. Kept as a literal
  // string, not an import, since this route never imports server-package code; it is
  // cross-referenced against `apps/api/src/lib/csrf.ts`'s own `CSRF_HEADER_NAME` export (that
  // file's own comment points back here) so the two names don't silently drift apart.
  const CSRF_HEADER_NAME = 'x-csrf-token'
  // Story 25.6 AC7 — `setAuthCookies()` (apps/api's tokens.ts) names the cookie `__Host-csrf-token`
  // in production (COOKIE_SECURE/HTTPS) and the bare `csrf-token` otherwise (dev/test, plain HTTP,
  // where a `__Host-`-prefixed cookie can never even be set) — this reads whichever one is
  // actually present rather than hardcoding one name, so this relay works unmodified in both
  // environments.
  const CSRF_COOKIE_NAMES = ['__Host-csrf-token', 'csrf-token']

  /**
   * Story 25.6 AC5 — reads the CSRF cookie's own value back out of `document.cookie` (the cookie
   * is deliberately NOT httpOnly — see tokens.ts's own comment — specifically so this relay can
   * do this) so it can be echoed as the `x-csrf-token` request header the server's
   * `isRejectedByCsrfToken()` check (apps/api/src/lib/csrf.ts) requires. Returns `undefined` (never
   * throws) if the cookie is missing — the server-side check fails closed on that, matching this
   * page's existing fail-closed conventions elsewhere.
   */
  function readCsrfCookie(): string | undefined {
    const cookies = document.cookie.split(';').map((entry) => entry.trim())
    for (const cookieName of CSRF_COOKIE_NAMES) {
      const prefix = `${cookieName}=`
      const match = cookies.find((entry) => entry.startsWith(prefix))
      if (match) return decodeURIComponent(match.slice(prefix.length))
    }
    return undefined
  }

  /**
   * Story 14-11/DW-236 (CentralizeMe) — a second, narrower relay alongside the action relay
   * above, for panels that need to read/write PV-native REST data the panel itself doesn't own
   * (e.g. CM's project-container panel listing/creating PV's own native `projects`). Same
   * underlying reason as the action relay: the panel iframe is `sandbox="allow-scripts"` with no
   * `allow-same-origin`, so it has a forced-opaque origin and its own CSP
   * (`compose-panel-document.ts`, `default-src 'none'`, no `connect-src`) blocks any `fetch()` it
   * issues directly. This page — real PV origin, real session cookie — performs the fetch on the
   * panel's behalf and posts the JSON result back.
   *
   * Deliberately NOT a general-purpose proxy: `isAllowedPanelDataPath()` is a host-owned
   * allowlist the panel cannot influence (method + path pattern only), matching the action
   * relay's own "host decides, extension never touches the network directly" posture. Extending
   * this to another PV-native resource means adding another host-owned pattern here, not
   * widening what an extension can request.
   */
  const PANEL_DATA_REQUEST_SOURCE = 'pv-extension-panel-data-request'
  const PANEL_DATA_RESULT_SOURCE = 'pv-extension-panel-data-result'
  const ALLOWED_PANEL_DATA_METHODS = new Set(['GET', 'POST'])

  /**
   * Story 25.12 AC2 — matches `path` against one manifest-declared template (`data.allowedDataPaths`
   * entries, e.g. `/api/v1/org/users/:id`) by STRUCTURAL SEGMENT COMPARISON, never by constructing
   * a `RegExp` from the template: split both on `/`, require the same segment count, each literal
   * template segment must exact-match its corresponding path segment, and each `:param` template
   * segment matches any single non-empty, `/`-free path segment. Deliberately not regex-based (see
   * this story's Dev Notes "Key Design Decisions") — a template is validated, bounded-charset,
   * manifest-declared data (packages/extension-api's `PANEL_DATA_PATH_PATTERN`), so a `RegExp`
   * approach isn't defending against untrusted input the way segment comparison already sidesteps
   * for free — no escaping logic, no catastrophic-backtracking surface to reason about.
   */
  function matchesPanelDataPathTemplate(template: string, path: string): boolean {
    const templateSegments = template.split('/')
    const pathSegments = path.split('/')
    if (templateSegments.length !== pathSegments.length) return false
    return templateSegments.every((templateSegment, index) => {
      const pathSegment = pathSegments[index]
      if (pathSegment === undefined) return false
      // A `:param` segment matches any single non-empty, `/`-free path segment — `/`-freedom is
      // structural (splitting on `/` already guarantees no segment itself contains a `/`), so
      // only non-emptiness needs checking here. A literal segment (including the leading empty
      // segment every absolute path/template produces before its first `/`) is an exact match.
      if (templateSegment.startsWith(':')) return pathSegment.length > 0
      return templateSegment === pathSegment
    })
  }

  function validatePanelDataRequest(
    method: unknown,
    path: unknown,
    allowedPaths: readonly string[]
  ): { method: 'GET' | 'POST'; path: string } | undefined {
    if (typeof method !== 'string' || !ALLOWED_PANEL_DATA_METHODS.has(method)) return undefined
    if (typeof path !== 'string') return undefined
    if (!allowedPaths.some((template) => matchesPanelDataPathTemplate(template, path))) {
      return undefined
    }
    return { method: method as 'GET' | 'POST', path }
  }

  /**
   * Story 25.8 AC3 — a new, typed, `requestId`-correlated postMessage type mirroring
   * `PANEL_ACTION_REQUEST_SOURCE`/`PANEL_DATA_REQUEST_SOURCE` above's exact shape: the panel
   * asks the host to navigate to a PV-native destination outside its own slot. Following those
   * two message types' own "host decides, panel names an intent, never a destination" posture
   * (Story 25.5/25.6): the panel sends a structured intent (`kind` + whatever identifiers that
   * kind needs), NEVER a raw URL — `goto()` is only ever called with a target THIS page's own
   * code constructs, never anything panel-supplied.
   */
  const PANEL_NAV_REQUEST_SOURCE = 'pv-extension-panel-navigation-request'
  const PANEL_NAV_RESULT_SOURCE = 'pv-extension-panel-navigation-result'

  /**
   * Story 25.8 AC3/Dev Notes "Security posture" — the host-owned allowlist of navigation
   * destinations a panel may request. Exactly one intent kind for this story's scope:
   * `pv-project-detail` (navigate to a PV-native project's own detail page). Adding a new
   * destination means adding a new `kind` here, never widening what a panel can supply directly.
   */
  type NavigationIntentKind = 'pv-project-detail'
  const ALLOWED_NAVIGATION_INTENT_KINDS = new Set<NavigationIntentKind>(['pv-project-detail'])

  function validateNavigationIntentShape(
    kind: unknown,
    projectId: unknown
  ): { kind: NavigationIntentKind; projectId: string } | undefined {
    if (
      typeof kind !== 'string' ||
      !ALLOWED_NAVIGATION_INTENT_KINDS.has(kind as NavigationIntentKind)
    ) {
      return undefined
    }
    if (typeof projectId !== 'string' || projectId.length === 0) return undefined
    return { kind: kind as NavigationIntentKind, projectId }
  }

  /**
   * Story 25.8 AC3 — Security Audit Personas finding (Elicitation Log #1): a message whose
   * `kind`/`projectId` are shape-valid is NOT by itself sufficient authorization to navigate —
   * the allowlist check must be a REAL check against the CURRENT session's own accessible
   * resources, not merely a shape/pattern match on `kind`. This reuses the exact same
   * host-mediated, real-session-cookie `fetch()` the data-request relay above already uses
   * (`credentials: 'same-origin'`), hitting `GET /api/v1/projects/:projectId` — a route already
   * gated by PV's own project-visibility check (org owner/admin, or a real `project_memberships`
   * row; see `apps/api`'s `parseVisibleProjectParams`/`callerCanSeeProject`). A non-2xx there
   * (403/404, deliberately indistinguishable — that route's own non-leaking-existence
   * convention) means "not authorized for THIS session", and this function returns `undefined`
   * rather than ever producing a `goto()` target — a shape-valid-but-cross-org request is
   * rejected here, not just a malformed one.
   */
  async function authorizeAndResolveNavigationTarget(intent: {
    kind: NavigationIntentKind
    projectId: string
  }): Promise<string | undefined> {
    try {
      const res = await fetch(`/api/v1/projects/${encodeURIComponent(intent.projectId)}`, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      if (!res.ok) return undefined
      return `/projects/${encodeURIComponent(intent.projectId)}`
    } catch {
      return undefined
    }
  }

  /**
   * Story 25.5 AC4/Task 4 — Bug fix (2026-08-24, found via real Chrome-driven manual
   * verification): the panel iframe can never fetch the host's action endpoint directly, no
   * matter what its CSP allows. `sandbox="allow-scripts"` without `allow-same-origin` (Story
   * 25.1's non-negotiable requirement) forces the iframe's document into an opaque origin, so
   * ANY fetch it issues is cross-origin by definition — `credentials: 'same-origin'` never
   * attaches the session cookie, and the browser blocks the request outright
   * (`TypeError: Failed to fetch`) regardless of `connect-src`. Confirmed live: the identical
   * request succeeds (200, real session) when issued from this parent page, but fails when
   * issued from inside the iframe.
   *
   * The fix: the panel now dispatches actions via `postMessage` instead of fetching directly.
   * This parent page — which has the real PV origin and the real session cookie — relays the
   * request to `data.actionEndpoint` on the panel's behalf and posts the result back. This is
   * also a net security improvement over the original direct-fetch design: the host mediates
   * every action request rather than granting the sandboxed extension its own network access,
   * consistent with `renderExtensionPanel()`'s existing "host decides, extension never touches
   * the network directly" posture.
   *
   * `event.source === panelIframe?.contentWindow` is the load-bearing check here — it identifies
   * WHICH window sent the message by object identity, which is reliable even though the iframe's
   * own origin is opaque (so `event.origin` is always the literal string `"null"` and can't be
   * used to distinguish this iframe from any other opaque-origin content on the page). Every
   * other field in the incoming message is untrusted extension-influenced input and is validated
   * before use; `data.actionEndpoint` — the actual fetch target — always comes from this page's
   * own server-resolved data, never from the message, so a compromised or malicious extension
   * can never redirect this relay to an arbitrary URL.
   */
  $effect(() => {
    function handlePanelDataMessage(
      event: MessageEvent,
      message: Record<string, unknown>
    ): boolean {
      if (message['source'] !== PANEL_DATA_REQUEST_SOURCE) return false
      const { requestId, method, path, body } = message
      if (typeof requestId !== 'string') return true
      const targetWindow = (event.source as Window | null) ?? panelIframe?.contentWindow
      // Story 25.8 Task 2a — captured at issue time; checked before this request's async result
      // is ever acted on, so a navigation-triggered srcdoc swap that happens while this fetch is
      // in flight explicitly drops the stale response instead of posting it to a detached window.
      const requestGeneration = panelGeneration
      pendingRequestIds.add(requestId)
      const validated = validatePanelDataRequest(method, path, data.allowedDataPaths)
      if (!validated) {
        targetWindow?.postMessage({ source: PANEL_DATA_RESULT_SOURCE, requestId, ok: false }, '*')
        pendingRequestIds.delete(requestId)
        return true
      }
      fetch(validated.path, {
        method: validated.method,
        credentials: 'same-origin',
        headers:
          validated.method === 'GET'
            ? { accept: 'application/json' }
            : { 'content-type': 'application/json', accept: 'application/json' },
        body: validated.method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      })
        .then(async (res) => {
          if (requestGeneration !== panelGeneration) return
          const parsedBody: unknown = await res.json().catch(() => null)
          targetWindow?.postMessage(
            {
              source: PANEL_DATA_RESULT_SOURCE,
              requestId,
              ok: true,
              status: res.status,
              body: parsedBody,
            },
            '*'
          )
        })
        .catch(() => {
          if (requestGeneration !== panelGeneration) return
          targetWindow?.postMessage({ source: PANEL_DATA_RESULT_SOURCE, requestId, ok: false }, '*')
        })
        .finally(() => pendingRequestIds.delete(requestId))
      return true
    }

    /**
     * Story 25.8 AC3/Task 2a — mirrors `handlePanelDataMessage`'s own sync-return/async-inner
     * shape: decides synchronously whether this message is a navigation request, then kicks off
     * the (async) authorization check without blocking the outer message handler.
     */
    function handlePanelNavigationMessage(
      event: MessageEvent,
      message: Record<string, unknown>
    ): boolean {
      if (message['source'] !== PANEL_NAV_REQUEST_SOURCE) return false
      const { requestId, kind, projectId } = message
      if (typeof requestId !== 'string') return true
      const targetWindow = (event.source as Window | null) ?? panelIframe?.contentWindow
      const requestGeneration = panelGeneration
      pendingRequestIds.add(requestId)

      const intent = validateNavigationIntentShape(kind, projectId)
      if (!intent) {
        targetWindow?.postMessage({ source: PANEL_NAV_RESULT_SOURCE, requestId, ok: false }, '*')
        pendingRequestIds.delete(requestId)
        return true
      }

      void authorizeAndResolveNavigationTarget(intent)
        .then(async (target) => {
          // Task 2a: the authorization check may still resolve after a navigation has already
          // swapped the panel's srcdoc — dropped explicitly, never silently posted/navigated.
          if (requestGeneration !== panelGeneration) return
          if (!target) {
            targetWindow?.postMessage(
              { source: PANEL_NAV_RESULT_SOURCE, requestId, ok: false },
              '*'
            )
            return
          }
          targetWindow?.postMessage({ source: PANEL_NAV_RESULT_SOURCE, requestId, ok: true }, '*')
          await goto(resolve(target))
        })
        .finally(() => pendingRequestIds.delete(requestId))
      return true
    }

    function handlePanelMessage(event: MessageEvent) {
      if (event.source !== panelIframe?.contentWindow) return
      const message = event.data as unknown
      if (typeof message !== 'object' || message === null) return
      const typedMessage = message as Record<string, unknown>
      if (handlePanelDataMessage(event, typedMessage)) return
      if (handlePanelNavigationMessage(event, typedMessage)) return
      if (typedMessage['source'] !== PANEL_ACTION_REQUEST_SOURCE) {
        return
      }
      const { requestId, kind } = typedMessage
      if (typeof requestId !== 'string' || typeof kind !== 'string') return
      if (data.actionEndpoint === undefined) return

      // Story 25.12 AC1 — forward the ENTIRE incoming message as the POST body, minus the two
      // envelope fields this relay itself owns (`source`/`requestId` — relay-internal
      // correlation fields the server has no use for and must never receive). A plain
      // object-rest destructure (not `Object.assign` onto a shared/reused object, never a
      // `JSON.parse`/re-stringify round trip) is deliberate: it produces a fresh plain object
      // whose own prototype is always `Object.prototype`, so a message field literally named
      // `__proto__` becomes an own, enumerable "__proto__" property of `action` rather than
      // reassigning `action`'s prototype — no prototype-pollution surface even though this
      // relay now forwards arbitrary extension-supplied keys. The server-side route (Story 25.5
      // AC1) already accepts a full `Record<string, unknown> & { kind: string }` action object
      // verbatim, so this requires zero server-side or wire-shape change.
      const { source: _source, requestId: _requestId, ...action } = typedMessage

      const targetWindow = panelIframe?.contentWindow
      // Story 25.8 Task 2a — see `handlePanelDataMessage`'s own identical comment above.
      const requestGeneration = panelGeneration
      pendingRequestIds.add(requestId)
      // Story 25.6 AC5 — attaches the CSRF token this page's own session cookie carries, the
      // client-side half of the double-submit-cookie pattern the server now requires (AC1/AC2).
      // Without this, the server's `isRejectedByCsrfToken()` check would reject every legitimate
      // relayed request too, not just cross-site forgeries.
      const csrfToken = readCsrfCookie()
      fetch(data.actionEndpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          ...(csrfToken !== undefined ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
        },
        body: JSON.stringify(action),
      })
        .then(async (res) => {
          if (requestGeneration !== panelGeneration) return
          const body: unknown = await res.json().catch(() => null)
          const message =
            body !== null && typeof body === 'object' && 'message' in body
              ? String((body as Record<string, unknown>)['message'])
              : undefined
          targetWindow?.postMessage(
            {
              source: PANEL_ACTION_RESULT_SOURCE,
              requestId,
              ok: true,
              status: res.status,
              message,
            },
            '*'
          )
        })
        .catch(() => {
          if (requestGeneration !== panelGeneration) return
          targetWindow?.postMessage(
            { source: PANEL_ACTION_RESULT_SOURCE, requestId, ok: false },
            '*'
          )
        })
        .finally(() => pendingRequestIds.delete(requestId))
    }

    window.addEventListener('message', handlePanelMessage)
    return () => window.removeEventListener('message', handlePanelMessage)
  })

  // Story 25.4 AC5 — WAI-ARIA APG SPA-navigation focus-management pattern: PV's Svelte routes
  // never do a full-page reload on navigation, so nothing moves keyboard focus to the new page's
  // content the way a traditional navigation would. This page is `apps/web`'s first instance of
  // the documented fix: give the page's own <h1> a tabindex="-1" (so it is programmatically
  // focusable without being in the normal Tab order) and move focus to it whenever the rendered
  // panel changes. A future page adopting the same convention should mirror this exact
  // tabindex="-1" + effect + .focus() shape.
  //
  // Code-review hardening (2026-08-24): this was originally an `onMount` that fires only once.
  // SvelteKit reuses this same component instance across client-side navigations between
  // different values of the same dynamic `[slot]` route (e.g. navigating from the `group` panel
  // to the `document` panel via an in-app link never remounts the component) — an `onMount`-only
  // fix silently fails to move focus on exactly the SPA-navigation case its own comment describes
  // solving. Keying off `data.slot` via `$effect` re-runs on every slot change, including the
  // initial mount.
  $effect(() => {
    data.slot
    heading?.focus()
  })

  // Story 29.1 AC1/AC9 — a change in `data.html` is exactly when the panel's actual rendered
  // content changes (mirrors the old `srcdoc`-keyed effect this replaces — Story 25.8 AC2/Task
  // 2a). Bumping the generation counter here (never inside the message handlers themselves) ties
  // invalidation to the real content swap, not merely to "a navigation was requested". Still
  // relevant even though the relay code this feeds is now inert (AC8) — a future story
  // (29.2/29.4/29.6) building the replacement will need the same generation-tracking discipline
  // against the new same-origin call sites, and removing it now would be pure churn.
  $effect(() => {
    data.html
    panelGeneration++
    pendingRequestIds.clear()
  })

  // Story 29.1 AC6 — resolves `data.themeVars` (already computed server-side by
  // `+page.server.ts` via `resolveExtensionThemeVars`/`extension-theme-vars.ts` — reused
  // verbatim, not reimplemented) into an inline `style` attribute string, applied on the panel's
  // own container element. Previously these vars were delivered via a `<style>:root{}</style>`
  // block inside the composed `srcdoc` document (`compose-panel-document.ts`); now that the panel
  // shares PV's own document, an inline custom-property declaration on the container is the
  // same-document equivalent — no document-level `<style>` block is needed or reintroduced.
  const panelThemeStyle = $derived(
    EXTENSION_THEME_CSS_VARS.map((name) => `${name}: ${data.themeVars[name]}`).join('; ')
  )
</script>

<svelte:head>
  <title>Extension | Project Vault</title>
</svelte:head>

<div class="mx-auto max-w-3xl px-4 py-8">
  <h1 bind:this={heading} tabindex="-1" class="text-2xl font-bold text-gray-900">Extension</h1>

  {#if data.html !== null}
    <!--
      Story 29.1 AC1/AC2/AC3/AC9 — the panel's HTML now renders directly into this real,
      same-origin, same-document container via the `renderPanelHtml` Svelte action (an imperative
      `element.innerHTML = sanitized` assignment inside a `use:` action), never through a Svelte
      template at-html directive — `svelte/no-at-html-tags` genuinely does not trigger on
      this syntax (see render-panel-html.ts's own doc comment). `DOMPurify.sanitize()` (explicitly
      configured — AC13) is now the real, primary control: there is no iframe sandbox boundary
      absorbing an XSS-shaped bug in the extension's HTML-generation code any more.

      Story 29.1 AC15 — SSR/hydration trade-off, decided and documented (not accidental): a
      `use:` action only runs client-side, after hydration — unlike the old `srcdoc` attribute
      (SSR-rendered directly into the initial HTML response), this container is visibly empty
      until client-side JS hydrates and the action runs. ACCEPTED, not mitigated with a loading
      skeleton: CentralizeMe panels already require an authenticated client-side app shell (this
      whole route is behind `requireUser()` in `+page.server.ts`) and are not indexed/SEO-relevant,
      so the brief flash-of-empty-content window this introduces has no meaningful user-facing or
      SEO cost worth the added complexity of a skeleton state.

      Story 29.1 AC9 — a plain `<div>`, not wrapped in any construct that would reintroduce an
      isolation boundary (no nested iframe, no closed-mode shadow DOM) — a stable, real,
      same-origin DOM mount point for Stories 29.2/29.6 to attach event handlers/anchors to
      directly.
    -->
    <div
      class="mt-6 overflow-hidden rounded-2xl border border-slate-200 p-4"
      style={panelThemeStyle}
      use:renderPanelHtml={data.html}
    ></div>
  {:else}
    <!-- AC5: the same calm placeholder for every degraded cause — throw, timeout, malformed
         result, or the extension/hook simply being gone by request time. Unchanged by this
         story. -->
    <div class="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-6">
      <p class="text-slate-600">This panel is temporarily unavailable.</p>
    </div>
  {/if}
</div>
