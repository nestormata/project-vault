<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import { m } from '$lib/paraglide/messages.js'

  // Story 72.11: nothing matches the current filter.
  let { data }: { data?: Record<string, readonly unknown[]> | undefined } = $props()
</script>

<!-- @region shares.home.empty -->
<RegionFragment>
  <div class="rounded-2xl border border-slate-200 bg-white p-6 text-slate-700">
    <p>{m.shares_index_empty()}</p>
    <InjectionPoint name="shares.home.empty" {data} />
  </div>
</RegionFragment>
