<script lang="ts">
  import type { DormancyAlertView } from '$lib/notifications/dormancy-alerts.js'
  import type { Snippet } from 'svelte'
  import MachineDormancyActions from '$lib/components/notifications/MachineDormancyActions.svelte'
  import MachineDormancyDetails from '$lib/components/notifications/MachineDormancyDetails.svelte'

  // Story 69.12: each alert card holds two sub-regions (the details, the actions row), each with its
  // own point.
  let {
    dormancyAlerts,
    data,
    children,
  }: {
    dormancyAlerts: DormancyAlertView[]
    data?: Record<string, readonly unknown[]> | undefined
    children?: Snippet
  } = $props()
</script>

{#if dormancyAlerts.length > 0}
  <div class="mb-6 space-y-3">
    <h2 class="text-sm font-semibold uppercase tracking-wide text-gray-500">
      Machine key dormancy alerts
    </h2>
    {#each dormancyAlerts as alert (alert.id)}
      <div class="rounded-lg border border-yellow-200 bg-yellow-50 p-4 shadow-sm">
        <MachineDormancyDetails {alert} {data} /><MachineDormancyActions {alert} {data} />
      </div>
    {/each}
  </div>
{/if}
{@render children?.()}
