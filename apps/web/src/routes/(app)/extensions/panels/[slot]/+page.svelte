<script lang="ts">
  import { composePanelDocument } from '$lib/security/compose-panel-document.js'
  let { data } = $props()

  let heading: HTMLHeadingElement | undefined
  // $state (unlike `heading` above) because the message-relay handler below reads this from
  // inside an event-listener closure, not directly in a reactive ($effect) scope — Svelte can't
  // otherwise guarantee that closure observes reassignment (e.g. a later slot navigation
  // re-binding the iframe element).
  let panelIframe: HTMLIFrameElement | undefined = $state(undefined)

  const PANEL_ACTION_REQUEST_SOURCE = 'pv-extension-panel-action'
  const PANEL_ACTION_RESULT_SOURCE = 'pv-extension-panel-action-result'

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
    function handlePanelMessage(event: MessageEvent) {
      if (event.source !== panelIframe?.contentWindow) return
      const message = event.data as unknown
      if (
        typeof message !== 'object' ||
        message === null ||
        (message as Record<string, unknown>)['source'] !== PANEL_ACTION_REQUEST_SOURCE
      ) {
        return
      }
      const { requestId, kind } = message as Record<string, unknown>
      if (typeof requestId !== 'string' || typeof kind !== 'string') return
      if (data.actionEndpoint === undefined) return

      const targetWindow = panelIframe?.contentWindow
      fetch(data.actionEndpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind }),
      })
        .then(async (res) => {
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
          targetWindow?.postMessage(
            { source: PANEL_ACTION_RESULT_SOURCE, requestId, ok: false },
            '*'
          )
        })
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
