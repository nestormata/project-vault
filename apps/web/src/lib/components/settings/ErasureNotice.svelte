<script lang="ts">
  import { invalidateAll } from '$app/navigation'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'

  // Story 69.11: the states of an erasure request that show only a notice (not allowed, not found,
  // being processed). `Refresh` re-runs the page load.
  let {
    state,
    data,
  }: {
    state: 'not_allowed' | 'not_found' | 'in_progress'
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region settings.users-erasure-detail.notice -->
<RegionFragment>
  {#if state === 'not_allowed'}
    <div class="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-6">
      <p class="text-slate-600">This page requires the admin role or above.</p>
    </div>
  {:else if state === 'not_found'}
    <div class="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-6">
      <p class="text-slate-600">This erasure request could not be found.</p>
    </div>
  {:else if state === 'in_progress'}
    <div class="mt-8 rounded-2xl border border-amber-200 bg-amber-50 p-6">
      <p class="text-amber-800">This erasure is currently being processed.</p>
      <button
        type="button"
        class="mt-3 rounded-xl border border-amber-300 px-3 py-2 text-sm font-semibold text-amber-800"
        onclick={() => void invalidateAll()}
      >
        Refresh
      </button>
    </div>
  {/if}<InjectionPoint name="settings.users-erasure-detail.notice" {data} />
</RegionFragment>
