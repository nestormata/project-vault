<script lang="ts">
  import { renderPanelHtml } from '$lib/security/render-panel-html.js'
  import { EXTENSION_THEME_CSS_VARS } from '$lib/security/extension-theme-vars.js'
  let { data } = $props()

  let heading: HTMLHeadingElement | undefined

  // Story 25.8 Task 2a — Boundary & Edge Case Sweep finding (Elicitation Log #3): a
  // navigation-triggered content swap could resolve a stale in-flight response into content that
  // no longer belongs on screen. `panelGeneration` is bumped every time the panel's resolved HTML
  // actually changes (see the `$effect` keyed on `data.html` below); Story 29.2's
  // `handleActionClick` captures the generation at click time and explicitly checks it before
  // ever acting on its own fetch's response, so a stale in-flight action result is deliberately
  // dropped rather than silently applied to the wrong panel instance.
  //
  // Story 29.6 AC3/AC4/AC5 — this counter's former sibling, `pendingRequestIds` (a
  // `SvelteSet<string>` tracking in-flight postMessage `requestId`s), is deleted: it had exactly
  // one remaining consumer, the now-deleted NAVIGATION postMessage relay. `panelGeneration`
  // itself is kept, unchanged, because it has a second, unrelated, still-live consumer —
  // `handleActionClick`'s own stale-response guard below — that has nothing to do with the
  // postMessage relay infrastructure this story removes.
  let panelGeneration = 0

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

  // Story 29.6 AC1/AC2/AC3 — a panel now triggers navigation by rendering a real `<a href>`
  // element directly in its own HTML (sanitized and injected via `renderPanelHtml`, same as any
  // other panel content) — an ordinary browser-native/SvelteKit-router click, not a `postMessage`
  // round trip. The `PANEL_NAV_REQUEST_SOURCE`/`PANEL_NAV_RESULT_SOURCE` message types, the
  // `NavigationIntentKind` allowlist, `validateNavigationIntentShape()`,
  // `authorizeAndResolveNavigationTarget()`, `handlePanelNavigationMessage()`, and the
  // `window.addEventListener('message', handlePanelMessage)` `$effect` that dispatched to it are
  // all deleted outright (matching the ACTION relay's Story 29.2 and DATA relay's Story 29.4
  // "delete outright, don't leave inert" precedent) — `handlePanelNavigationMessage` was the last
  // live branch of `handlePanelMessage`, so nothing calls it any more once this deletion lands.
  // No host-side authorization check replaces it: both destination routes a panel-rendered link
  // can reach (`/projects/[projectId]`, this same `[...subpath]` route) already perform their own
  // independent, pre-existing authorization on every request, regardless of how it arrived (AC7).

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
  // 2a). Bumping the generation counter here (never inside a request handler itself) ties
  // invalidation to the real content swap, not merely to "a request was issued". Story 29.6
  // deletes this effect's own `pendingRequestIds.clear()` call — that `SvelteSet` was the
  // NAVIGATION relay's own in-flight-requestId bookkeeping, now gone along with the relay itself
  // — `panelGeneration`'s increment below stays, unchanged, since `handleActionClick`'s own
  // stale-response guard (Story 29.2 AC9) is still a live consumer.
  $effect(() => {
    data.html
    panelGeneration++
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
