<script lang="ts">
  import type { PublicStatusPage } from '@project-vault/shared'
  import type { Snippet } from 'svelte'
  import StatusServiceList from './StatusServiceList.svelte'

  let { statusPage, children }: { statusPage: PublicStatusPage | null; children?: Snippet } =
    $props()
</script>

<div class="mx-auto max-w-2xl px-4 py-10">
  {#if statusPage}
    <h1 class="text-2xl font-bold text-slate-950">Service status</h1>
    <StatusServiceList {statusPage} />
  {:else}
    <h1 class="text-2xl font-bold text-slate-950">Status page not available</h1>
    <p class="mt-3 text-slate-600">
      This link is invalid, has been disabled, or is temporarily unavailable.
    </p>
  {/if}
</div>
{@render children?.()}
