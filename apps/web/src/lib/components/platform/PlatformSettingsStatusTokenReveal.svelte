<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'

  // Story 69.10: the display-once reveal of a freshly generated or rotated status token as one
  // replaceable region. The token itself is only a prop of this component, never of its point.
  let {
    token,
    copied,
    copyFailed,
    onCopy,
    data,
  }: {
    token: string
    copied: boolean
    copyFailed: boolean
    onCopy: (value: string) => Promise<void>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region platform.settings.status-token-reveal -->
<RegionFragment>
  <div class="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
    <p class="text-sm font-medium text-amber-900">
      {m.status_token_reveal_notice()}
    </p>
    <div class="mt-2 flex items-center gap-2">
      <code
        class="flex-1 overflow-x-auto rounded border border-amber-200 bg-white px-2 py-1.5 text-xs"
        >{token}</code
      >
      <button
        type="button"
        class="rounded border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100"
        onclick={() => onCopy(token)}
      >
        {copied ? m.status_token_copy_button_copied() : m.status_token_copy_button()}
      </button>
    </div>
    {#if copyFailed}
      <p class="mt-2 text-xs font-medium text-red-700" role="alert">
        {m.status_token_copy_failed()}
      </p>
    {/if}<InjectionPoint name="platform.settings.status-token-reveal" {data} />
  </div>
</RegionFragment>
