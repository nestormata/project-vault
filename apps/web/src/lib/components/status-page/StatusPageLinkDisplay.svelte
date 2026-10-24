<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { StatusPageLinkPointProps } from '$lib/components/composition/injection-points.js'

  // Story 69.12: how the "Shareable link" card shows the link (the link and its copy button, the
  // legacy-link notice, or the temporarily-unavailable notice). `publicUrl` holds the bearer token
  // and stays in this component: a contribution at `project.status-page.link-display` receives
  // `{ project, hasPublicUrl, isLegacy }` (flags), never the token or the URL (AC-6.6).
  let {
    project,
    publicUrl,
    legacyToken,
    copied,
    onCopy,
    data,
  }: {
    project: StatusPageLinkPointProps['project']
    publicUrl: string | null
    legacyToken: boolean
    copied: boolean
    onCopy: () => void | Promise<void>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.status-page.link-display -->
<RegionFragment>
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
    name="project.status-page.link-display"
    props={{ project, hasPublicUrl: Boolean(publicUrl), isLegacy: legacyToken }}
    {data}
  />
</RegionFragment>
