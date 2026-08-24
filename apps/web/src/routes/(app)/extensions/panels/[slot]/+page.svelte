<script lang="ts">
  import { composePanelDocument } from '$lib/security/compose-panel-document.js'
  let { data } = $props()

  let heading: HTMLHeadingElement | undefined

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
      <iframe title={iframeTitle} sandbox="allow-scripts" {srcdoc} class="h-[70vh] w-full border-0"
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
