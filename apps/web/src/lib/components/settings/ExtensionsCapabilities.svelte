<script lang="ts">
  import type { ExtensionStatus } from '$lib/api/extensions.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'

  // Story 69.11: the capabilities the loaded extension declares.
  let {
    capabilities,
    data,
  }: {
    capabilities: ExtensionStatus['capabilities']
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region settings.extensions.capabilities -->
<RegionFragment>
  <div class="mt-4">
    {#if capabilities.length === 0}
      <p class="text-sm text-slate-500">No capabilities declared</p>
    {:else}
      <div class="flex flex-wrap gap-2">
        <!-- Keyed by index, not value: the API's capabilities schema
             (apps/api/src/extensions/status-routes.ts) only validates enum membership, not
             array uniqueness, so a malformed manifest could declare the same capability
             twice — a value-keyed {#each} would crash the whole page with a Svelte
             each_key_duplicate error in that case (confirmed via a manual repro during code
             review). Index keys tolerate duplicates without changing the rendered output. -->
        {#each capabilities as capability, index (index)}
          <span
            class="rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700"
          >
            {capability}
          </span>
        {/each}
      </div>
    {/if}<InjectionPoint name="settings.extensions.capabilities" {data} />
  </div>
</RegionFragment>
