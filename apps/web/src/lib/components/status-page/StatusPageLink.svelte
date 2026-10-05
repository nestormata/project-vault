<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import type { StatusPageLinkPointProps } from '$lib/components/composition/injection-points.js'
  import ConfirmDeleteButton from '$lib/components/forms/ConfirmDeleteButton.svelte'

  // Story 69.3: the "Shareable link" card (regenerate, disable, the link itself) as one replaceable
  // region. It renders only when the page is enabled and the caller can manage it. `publicUrl` holds
  // the bearer token and stays in this component: a contribution at `project.status-page.link`
  // receives `{ project, hasPublicUrl, isLegacy }` (flags), never the token or the URL (AC-6.6).
  let {
    project,
    publicUrl,
    legacyToken,
    copied,
    isBusy,
    onRegenerate,
    onDisable,
    onCopy,
    data,
  }: {
    project: StatusPageLinkPointProps['project']
    publicUrl: string | null
    legacyToken: boolean
    copied: boolean
    isBusy: boolean
    onRegenerate: () => void | Promise<void>
    onDisable: () => void | Promise<void>
    onCopy: () => void | Promise<void>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.status-page.link -->
<div class="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <div class="flex items-center justify-between">
    <h2 class="text-xl font-semibold text-slate-950">Shareable link</h2>
    <div class="flex gap-2">
      <!-- Story 6.6 AC-3/AC-6: two-step confirm (reused ConfirmDeleteButton pattern) so
           rotation always requires an explicit label + a second click that warns the old
           link stops working, instead of firing on a single click. `variant="neutral"`
           keeps this visually distinct from the genuinely irreversible Disable button next
           to it — regenerating a link is not the same severity as disabling the page. -->
      <ConfirmDeleteButton
        label={legacyToken ? 'Migrate to persistent link' : 'Regenerate link'}
        confirmLabel="Confirm — old link stops working?"
        pendingLabel={legacyToken ? 'Migrating…' : 'Regenerating…'}
        variant="neutral"
        disabled={isBusy}
        onConfirm={onRegenerate}
      />
      <button
        class="rounded-xl border border-red-300 px-3 py-2 text-sm font-semibold text-red-700 disabled:cursor-not-allowed disabled:opacity-60"
        type="button"
        disabled={isBusy}
        onclick={() => onDisable()}
      >
        Disable
      </button>
    </div>
  </div>

  {#if publicUrl}
    <div class="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div class="flex flex-wrap items-center gap-2">
        <code class="break-all rounded-lg bg-white px-3 py-2 text-sm">{publicUrl}</code>
        <button
          class="rounded-lg bg-slate-950 px-3 py-2 text-sm font-semibold text-white"
          type="button"
          onclick={() => onCopy()}
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
    </div>
  {:else if legacyToken}
    <!-- Story 6.6 AC-4: this URL predates persistent-link support and genuinely cannot be
         reconstructed from its stored hash — distinct, honest copy from the transient
         sealed-vault fallback below, plus the "Migrate to persistent link" action above. -->
    <p class="text-sm text-slate-500">
      This link was created before persistent links were supported, so it can't be redisplayed — its
      hash can't be reversed into the original URL. The existing shared link keeps working. Use
      "Migrate to persistent link" above for a link you can copy again later; doing so invalidates
      the current shared URL.
    </p>
  {:else}
    <p class="text-sm text-slate-500">
      This link is temporarily unavailable — try again shortly, or regenerate to get a persistent
      link.
    </p>
  {/if}<InjectionPoint
    name="project.status-page.link"
    props={{ project, hasPublicUrl: Boolean(publicUrl), isLegacy: legacyToken }}
    {data}
  />
</div>
