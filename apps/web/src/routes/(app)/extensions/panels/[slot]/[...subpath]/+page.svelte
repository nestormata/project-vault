<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { SvelteSet } from 'svelte/reactivity'
  import { composePanelDocument } from '$lib/security/compose-panel-document.js'
  let { data } = $props()

  let heading: HTMLHeadingElement | undefined
  // $state (unlike `heading` above) because the message-relay handler below reads this from
  // inside an event-listener closure, not directly in a reactive ($effect) scope — Svelte can't
  // otherwise guarantee that closure observes reassignment (e.g. a later slot navigation
  // re-binding the iframe element).
  let panelIframe: HTMLIFrameElement | undefined = $state(undefined)

  // Story 25.8 Task 2a — Boundary & Edge Case Sweep finding (Elicitation Log #3): a
  // navigation-triggered `srcdoc` swap tears down the old iframe document and creates a NEW
  // `contentWindow`. Without this, an in-flight action/data-request/navigation-request's
  // response would silently resolve into a stale/detached window with no error ever surfaced —
  // dropped forever, unnoticed. `panelGeneration` is bumped every time the composed `srcdoc`
  // actually changes (see the `$effect` keyed on it below); every request handler captures the
  // generation at issue time and EXPLICITLY checks it before ever posting a response back or
  // acting on one, so a stale in-flight request is deliberately dropped, not silently left to
  // resolve into nothing. `pendingRequestIds` mirrors which requestIds are currently in flight
  // (added on issue, removed on settle) — cleared on every generation bump, so it also always
  // reflects only the CURRENT panel instance's own in-flight requests.
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
  const ALLOWED_PANEL_DATA_PATH_PATTERNS = [/^\/api\/v1\/projects$/, /^\/api\/v1\/projects\/[^/]+$/]

  function validatePanelDataRequest(
    method: unknown,
    path: unknown
  ): { method: 'GET' | 'POST'; path: string } | undefined {
    if (typeof method !== 'string' || !ALLOWED_PANEL_DATA_METHODS.has(method)) return undefined
    if (typeof path !== 'string') return undefined
    if (!ALLOWED_PANEL_DATA_PATH_PATTERNS.some((pattern) => pattern.test(path))) return undefined
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
      const validated = validatePanelDataRequest(method, path)
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
        body: JSON.stringify({ kind }),
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

  // Story 25.4 AC5 — Pre-mortem finding: a screen-reader user with several panel tabs open across
  // different slots would otherwise hear the identical generic "Extension panel" title for every
  // one of them. Falls back to the generic title only if `slot` is somehow empty, which the
  // existing slot-validation already prevents from reaching this far.
  const iframeTitle = $derived(data.slot ? `Extension panel: ${data.slot}` : 'Extension panel')

  // Story 25.4 AC1/AC4 — the extension's raw html fragment is never assigned to `srcdoc` directly
  // any more; it is always wrapped by the host-controlled composition function first (CSP meta +
  // --pv-ext-* theme block + the fragment itself, verbatim — AC2 RESOLVED: no sanitizer).
  // Story 25.5 AC4/Task 4 — module actions no longer widen this composed CSP (see
  // compose-panel-document.ts's design-history comment): the panel dispatches actions via the
  // postMessage relay above instead of fetching directly, so it never needs outbound network
  // access at all.
  const srcdoc = $derived(
    data.html !== null ? composePanelDocument(data.html, data.themeVars) : null
  )

  // Story 25.8 AC2/Task 2a — a change in the composed `srcdoc` value is exactly when the browser
  // actually reloads the iframe document (a `srcdoc` attribute change that doesn't change value
  // never triggers a reload) — including both a sub-state navigation swapping which HTML is
  // rendered AND a browser-initiated back/forward that resyncs `data` to an earlier/later
  // sub-state. Bumping the generation counter here (never inside the message handlers
  // themselves) ties invalidation to the real DOM event that actually tears down the old
  // `contentWindow`, not merely to "a navigation was requested".
  $effect(() => {
    srcdoc
    panelGeneration++
    pendingRequestIds.clear()
  })
</script>

<svelte:head>
  <title>Extension | Project Vault</title>
</svelte:head>

<div class="mx-auto max-w-3xl px-4 py-8">
  <h1 bind:this={heading} tabindex="-1" class="text-2xl font-bold text-gray-900">Extension</h1>

  {#if srcdoc !== null}
    <!--
      Story 25.1 AC4 — SECURITY: `allow-same-origin` must NEVER be added to this sandbox token
      set. `srcdoc` content inherits the *embedding page's own origin*, not a neutral/opaque one
      — `allow-scripts` alone keeps the sandboxed document's origin forced-opaque (unique,
      unrelated to PV's), so a bug in the panel's returned HTML cannot read PV's own
      cookies/Web Storage/DOM. Adding `allow-same-origin` on top of `allow-scripts` for `srcdoc`
      content is a well-documented escape class (the two combined let sandboxed script access the
      parent document's real origin) — this is not hypothetical, it is the single most important
      token-choice constraint in this story. A future PR "helpfully" adding `allow-same-origin` to
      fix a panel-compatibility complaint would silently reopen this exact hole.

      Story 25.4 AC1 — the composed document (see `composePanelDocument` above) now also carries a
      restrictive Content-Security-Policy delivered via a head-level `<meta http-equiv>` tag,
      closing the network/resource-loading gap `allow-scripts` alone never covered (Story 25.1's
      own Dev Notes explicitly flagged this as future scope — this is that story).
    -->
    <div class="mt-6 overflow-hidden rounded-2xl border border-slate-200">
      <iframe
        bind:this={panelIframe}
        title={iframeTitle}
        sandbox="allow-scripts"
        {srcdoc}
        class="h-[70vh] w-full border-0"
      ></iframe>
    </div>
  {:else}
    <!-- AC3: the same calm placeholder for every degraded cause — throw, timeout, malformed
         result, or the extension/hook simply being gone by request time. -->
    <div class="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-6">
      <p class="text-slate-600">This panel is temporarily unavailable.</p>
    </div>
  {/if}
</div>
