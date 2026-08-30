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
  // exists any more, but the remaining NAVIGATION postMessage relay code (AC8) still references
  // it (see that code's own comment) pending Story 29.6, which is why the `$state`/type is kept
  // as-is rather than renamed here (a rename would touch every line of that inert relay code for
  // no functional reason, ahead of the story that is actually replacing it).
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
  // sandboxed iframe's `contentWindow`. The ACTION relay (Story 29.2) and DATA relay (Story 29.4)
  // have both since been retired outright, replaced by direct same-origin calls; only the
  // NAVIGATION relay below remains, pending Story 29.6. Do not delete or "fix" this remaining
  // code here — that is explicitly out of this story's scope.
  let panelGeneration = 0
  const pendingRequestIds = new SvelteSet<string>()

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
   * Story 25.8 AC3 — a typed, `requestId`-correlated postMessage type (mirroring the now-deleted
   * DATA relay's own shape — Story 29.4 — and the now-retired ACTION relay's own original shape
   * — see Story 29.2): the panel asks the host to navigate to a PV-native destination outside its
   * own slot. Following those two message types' own "host decides, panel names an intent, never
   * a destination" posture (Story 25.5/25.6): the panel sends a structured intent (`kind` +
   * whatever identifiers that kind needs), NEVER a raw URL — `goto()` is only ever called with a
   * target THIS page's own code constructs, never anything panel-supplied.
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
   * Story 25.5 AC4/Task 4 (original scope: the ACTION relay retired by Story 29.2 — see
   * `handleActionClick` below for its direct-fetch replacement) — the NAVIGATION relay below
   * still relies on the same `event.source === panelIframe?.contentWindow` identity check: it
   * identifies WHICH window sent the message by object identity, which is reliable even though
   * the iframe's own origin is opaque (so `event.origin` is always the literal string `"null"`
   * and can't be used to distinguish this iframe from any other opaque-origin content on the
   * page). Every other field in an incoming message is untrusted extension-influenced input and
   * is validated before use.
   */
  $effect(() => {
    /**
     * Story 25.8 AC3/Task 2a — decides synchronously whether this message is a navigation
     * request, then kicks off the (async) authorization check without blocking the outer message
     * handler.
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

    // Story 29.2 AC4 — the ACTION relay branch that used to live here (dispatching to
    // `PANEL_ACTION_REQUEST_SOURCE`/`PANEL_ACTION_RESULT_SOURCE`) is retired outright, replaced
    // by the host-owned click-delegation handler below (`handleActionClick`). Story 29.4 AC7 —
    // the DATA relay branch that used to live here (dispatching to `PANEL_DATA_REQUEST_SOURCE`)
    // is likewise retired outright, replaced by `apps/api`'s own directly-mounted module-data
    // routes under `/api/v1/extensions/data` — a manifest-declared route needs no client-side
    // relay at all. The NAVIGATION relay below is unchanged and untouched, pending Story 29.6.
    function handlePanelMessage(event: MessageEvent) {
      if (event.source !== panelIframe?.contentWindow) return
      const message = event.data as unknown
      if (typeof message !== 'object' || message === null) return
      const typedMessage = message as Record<string, unknown>
      handlePanelNavigationMessage(event, typedMessage)
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
  // relevant for the remaining NAVIGATION relay (the ACTION relay this fed was retired by Story
  // 29.2, the DATA relay by Story 29.4) — Story 29.6 building that relay's replacement will need
  // the same generation-tracking discipline against the new same-origin call site, and removing
  // it now would be pure churn.
  $effect(() => {
    data.html
    panelGeneration++
    pendingRequestIds.clear()
    // Story 29.2 Task 2 — a new `data.html` (real navigation, not an action result) always wins
    // over any action-result override still showing from a previous slot; reset both the
    // override and the AC6/AC7 status message so neither leaks across a slot change.
    actionResultHtml = null
    statusMessage = undefined
  })

  // Story 29.2 AC1/AC10 — the data-attribute action-declaration convention this story adds: a
  // panel marks an actionable element with `data-pv-action="<kind>"` (required, non-empty, ≤128
  // chars — mirrors `apps/api/src/extensions/panel-routes.ts`'s own `MAX_ACTION_KIND_LENGTH`;
  // enforced server-side, not re-validated client-side here, since an over-length/empty `kind`
  // simply fails the server's own existing shape check) plus any number of
  // `data-pv-action-<field>="<string>"` attributes for extra flat, string-valued request-body
  // fields. These are ordinary `data-*` attributes — DOMPurify's default `ALLOW_DATA_ATTR: true`
  // (unmodified by this story or Story 29.1) already lets them survive sanitization on any
  // allowed element; no new `SANITIZE_CONFIG` entry is needed or added (confirmed via this file's
  // own click-dispatch tests, which exercise the real sanitize pipeline end to end).
  const GENERIC_ACTION_ERROR_MESSAGE = 'Unable to complete this action. Please try again.'

  // Story 29.2 AC5 — a local override for the panel container's rendered content: when an
  // action's response carries a non-empty `html` result, this is set to that HTML and bound into
  // the SAME `use:renderPanelHtml={...}` expression the template already uses for `data.html`
  // (see the template below), so the result flows through the exact same sanitize-and-inject
  // pipeline rather than a second, independently-sanitized-or-unsanitized `innerHTML` assignment.
  // Reset to `null` (falling back to `data.html`) whenever `data.html` itself changes (above).
  let actionResultHtml: string | null = $state(null)

  // Story 29.2 AC6/AC7 — the host-owned, `aria-live="polite"` status message shown outside the
  // panel container (see the template below) for a `message`-only success result or any failure
  // outcome. `undefined` renders nothing.
  let statusMessage: string | undefined = $state(undefined)

  /** Story 29.2 AC8 — re-enables the clicked action element once its request settles, unless the
   * AC5 branch has already replaced the container's entire content (in which case the element is
   * no longer in the DOM and there is nothing to re-enable — callers skip calling this in that
   * branch). */
  function reenableActionElement(element: HTMLElement): void {
    element.removeAttribute('disabled')
    element.removeAttribute('aria-busy')
  }

  /**
   * Story 29.2 — the host-owned replacement for the retired ACTION postMessage relay
   * (`handlePanelMessage`'s deleted branch, above). Bound exactly once, directly on the panel
   * container element in the template below — never re-attached on re-render, since Story 29.1's
   * `renderPanelHtml` action only ever reassigns `.innerHTML` on this same DOM node, never
   * replaces it (AC2). Resolves the actual action element via `.closest('[data-pv-action]')`,
   * bounded to the container's own descendants, so a click anywhere inside an action element's
   * subtree (e.g. on a nested icon/text node) still resolves correctly.
   */
  function handleActionClick(event: MouseEvent): void {
    const container = event.currentTarget as HTMLElement
    const clickedNode = event.target as HTMLElement | null
    const actionEl = clickedNode?.closest('[data-pv-action]') as HTMLElement | null
    if (!actionEl || !container.contains(actionEl)) return
    // AC3 — a `data-pv-action` element with no declared `moduleActions` (no `actionEndpoint`) is
    // a silent no-op, matching the retired relay's own existing guard.
    if (data.actionEndpoint === undefined) return
    // AC8 — ignore a reentrant click on an element whose own in-flight request hasn't settled.
    if (actionEl.hasAttribute('disabled')) return

    const kind = actionEl.getAttribute('data-pv-action')
    if (!kind) return

    // AC3 — a safe accumulation pattern (`Object.fromEntries`, never `Object.assign` onto a
    // shared/reused object — mirrors Story 25.12's own prototype-pollution-safe precedent): a
    // panel-declared `data-pv-action-__proto__` field becomes an own, enumerable "__proto__"
    // property of the resulting plain object (whose own prototype is always `Object.prototype`)
    // rather than reassigning that object's prototype.
    const fieldEntries = Array.from(actionEl.attributes)
      .filter((attr) => attr.name.startsWith('data-pv-action-'))
      .map((attr) => [attr.name.slice('data-pv-action-'.length), attr.value] as [string, string])
    const requestBody = Object.fromEntries([['kind', kind], ...fieldEntries])

    // AC8 — mark the element in-flight before issuing the request.
    actionEl.setAttribute('disabled', '')
    actionEl.setAttribute('aria-busy', 'true')

    // Story 25.8 Task 2a — captured at click time; checked before this request's async result is
    // ever acted on (AC9), exactly like the DATA/NAVIGATION relay handlers above do for their own
    // in-flight requests — a slot navigation that swaps `data.html` while this fetch is still in
    // flight causes that stale result to be silently dropped.
    const requestGeneration = panelGeneration
    // Story 25.6 AC5 — reuses `readCsrfCookie()`/`CSRF_HEADER_NAME` completely unchanged; only the
    // trigger moves from an incoming `postMessage` event to this resolved DOM click (AC3).
    const csrfToken = readCsrfCookie()

    fetch(data.actionEndpoint, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        ...(csrfToken !== undefined ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
      },
      body: JSON.stringify(requestBody),
    })
      .then(async (res) => {
        if (requestGeneration !== panelGeneration) return
        const parsed: unknown = await res.json().catch(() => null)
        const parsedBody: Record<string, unknown> =
          parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}

        if (res.ok) {
          const html = parsedBody['html']
          if (typeof html === 'string' && html.length > 0) {
            // AC5 — the clicked element no longer exists once this replaces the container's
            // entire content, so there is nothing left to re-enable (AC8).
            actionResultHtml = html
            statusMessage = undefined
            return
          }
          const message = parsedBody['message']
          statusMessage = typeof message === 'string' ? message : undefined
          reenableActionElement(actionEl)
          return
        }

        // AC7 — the server's own `message` is shown verbatim only for `validation_failed`/
        // `conflict` (the two outcomes `panel-routes.ts` documents as user-facing); every other
        // outcome (`denied`/`invalid_slot`/`action_not_found`/`internal_error`/anything
        // unrecognized) gets a fixed, generic, non-leaking message.
        const code = parsedBody['code']
        const serverMessage = parsedBody['message']
        statusMessage =
          (code === 'validation_failed' || code === 'conflict') && typeof serverMessage === 'string'
            ? serverMessage
            : GENERIC_ACTION_ERROR_MESSAGE
        reenableActionElement(actionEl)
      })
      .catch(() => {
        if (requestGeneration !== panelGeneration) return
        // AC7 — a network-level fetch rejection never surfaces raw exception text.
        statusMessage = GENERIC_ACTION_ERROR_MESSAGE
        reenableActionElement(actionEl)
      })
  }

  // Story 29.1 AC6 — resolves `data.themeVars` (already computed server-side by
  // `+page.server.ts` via `resolveExtensionThemeVars`/`extension-theme-vars.ts` — reused
  // verbatim, not reimplemented) into an inline `style` attribute string, applied on the panel's
  // own container element. Previously these vars were delivered via a `<style>:root{}</style>`
  // block inside the composed `srcdoc` document (`compose-panel-document.ts`); now that the panel
  // shares PV's own document, an inline custom-property declaration on the container is the
  // same-document equivalent — no document-level `<style>` block is needed or reintroduced.
  // Code-review hardening (2026-08-29) — `contain: layout` establishes this container as the
  // containing block for any `position: fixed`/`position: absolute` descendant (CSS Containment
  // spec), so it clips such descendants to this container's own box instead of the viewport. The
  // old iframe boundary made this a structural non-issue (a `position: fixed` element inside the
  // iframe's own document could only ever cover the iframe's box, never the host page); sharing
  // PV's own document removes that for free, and `DOMPurify.sanitize()` does not restrict CSS
  // property VALUES (only which elements/attributes survive) — a panel emitting
  // `style="position:fixed;inset:0;z-index:99999"` would otherwise be able to cover the entire
  // host page. This is a real containing-block change (not merely visual), and is required in
  // addition to sanitization, not instead of it.
  const panelThemeStyle = $derived(
    `contain: layout; ${EXTENSION_THEME_CSS_VARS.map((name) => `${name}: ${data.themeVars[name]}`).join('; ')}`
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

      Story 29.2 AC2 — `onclick={handleActionClick}` is this story's single, host-owned delegated
      click handler, bound once directly to this container element. It survives every
      `data.html`-driven re-render without needing to be re-attached, because `renderPanelHtml`
      only ever reassigns this same element's `.innerHTML`, never replaces the element itself.

      Story 29.2 AC5 — `actionResultHtml ?? data.html` routes a successful action `html` result
      through this exact same sanitize-and-inject pipeline, never a second raw `innerHTML`
      assignment.

      Story 29.2 — the a11y click-delegation lint rules below are suppressed deliberately: this
      container itself is never the interactive target (it has no interactive role of its own),
      only a genuine event-delegation host for its rendered, already-interactive descendants
      (panel-declared `<button data-pv-action="...">` elements, which carry their own native
      keyboard activation for free). Adding a keyboard handler or interactive role to THIS
      element would be actively wrong, not merely redundant.
    -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="mt-6 overflow-hidden rounded-2xl border border-slate-200 p-4"
      style={panelThemeStyle}
      role="region"
      aria-label={`Extension panel: ${data.slot}`}
      use:renderPanelHtml={actionResultHtml ?? data.html}
      onclick={handleActionClick}
    ></div>
  {:else}
    <!-- AC5: the same calm placeholder for every degraded cause — throw, timeout, malformed
         result, or the extension/hook simply being gone by request time. Unchanged by this
         story. -->
    <div class="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-6">
      <p class="text-slate-600">This panel is temporarily unavailable.</p>
    </div>
  {/if}

  <!--
    Story 29.2 AC6/AC7 — a small, host-template-owned `aria-live="polite"` status element, living
    outside the sanitized panel container above (a sibling in this page's own template, never
    written into the container's `innerHTML`). Shows a `message`-only action result (AC6) or a
    failure outcome (AC7). Because this element lives outside the container, a panel's own HTML
    cannot spoof or overwrite it merely by emitting a colliding `id`/element inside its own
    sanitized markup. Always present in the DOM (not conditionally rendered) so assistive
    technology reliably picks up the live-region update the moment `statusMessage` changes.
  -->
  <p class="mt-4 text-sm text-slate-600" aria-live="polite">{statusMessage ?? ''}</p>
</div>
