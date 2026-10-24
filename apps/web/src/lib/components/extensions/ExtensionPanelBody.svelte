<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import { renderPanelHtml } from '$lib/security/render-panel-html.js'

  // Story 69.12: the panel container (or its unavailable placeholder) of the legacy extension panel
  // page, moved here unchanged from `ExtensionPanelContent.svelte`. The page keeps all the state
  // (`actionResultHtml`, the generation counter, the click handler) and hands it down: `html` is the
  // page's `data.html`, `themeStyle` its `panelThemeStyle`, `onclick` its `handleActionClick`. The
  // point sits right after the `{#if}` block.
  let {
    html,
    slot,
    themeStyle,
    actionResultHtml,
    onclick,
    data,
  }: {
    html: string | null
    slot: string
    themeStyle: string
    actionResultHtml: string | null
    onclick: (event: MouseEvent) => void
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region extensions.panels-detail.panel -->
<RegionFragment>
  {#if html !== null}
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
    skeleton: extension panels already require an authenticated client-side app shell (this
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
      style={themeStyle}
      role="region"
      aria-label={`Extension panel: ${slot}`}
      use:renderPanelHtml={actionResultHtml ?? html}
      {onclick}
    ></div>
  {:else}
    <!-- AC5: the same calm placeholder for every degraded cause — throw, timeout, malformed
       result, or the extension/hook simply being gone by request time. Unchanged by this
       story. -->
    <div class="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-6">
      <p class="text-slate-600">This panel is temporarily unavailable.</p>
    </div>
  {/if}<InjectionPoint name="extensions.panels-detail.panel" {data} />
</RegionFragment>
