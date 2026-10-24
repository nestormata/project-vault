<script lang="ts">
  import { resolve } from '$app/paths'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { BackupsController } from './backups-controller.svelte.js'

  // Story 69.14: the trigger, restore-complete and page-load banners as one replaceable region.
  let {
    controller,
    pageError,
    data,
  }: {
    controller: BackupsController
    pageError: string | null
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region platform.backups.alerts -->
<RegionFragment>
  {#if controller.triggerMessage}
    <p
      class="mt-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800"
      role="status"
    >
      {controller.triggerMessage}
    </p>
  {/if}
  {#if controller.triggerError}
    <p
      class="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
      role="alert"
    >
      {controller.triggerError}
    </p>
  {/if}

  {#if controller.restoreSuccess}
    <div
      class="mt-4 rounded-lg border border-green-300 bg-green-50 px-4 py-4 text-sm text-green-900"
      role="status"
    >
      <p class="font-semibold">Restore complete.</p>
      <p class="mt-1">
        The vault has been automatically sealed and requires manual unseal to resume operation.
        <a href={resolve('/vault')} class="ml-1 underline hover:text-green-700">Unseal vault →</a>
      </p>
    </div>
  {/if}

  {#if pageError}
    <p
      class="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
      role="alert"
    >
      {pageError}
    </p>
  {/if}<InjectionPoint name="platform.backups.alerts" {data} />
</RegionFragment>
