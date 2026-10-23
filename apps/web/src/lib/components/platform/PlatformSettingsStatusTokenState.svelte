<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'

  // Story 69.10: the configured / not configured line and the created and last-used dates of the
  // status token as one replaceable region.
  let {
    configured,
    createdAt,
    lastUsedAt,
    data,
  }: {
    configured: boolean
    createdAt: string | undefined
    lastUsedAt: string | undefined
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region platform.settings.status-token-state -->
<RegionFragment>
  <div class="mt-4 text-sm text-gray-700">
    <p>
      {m.status_token_status_label()}
      {#if configured}<span data-testid="status-token-state" class="font-medium text-green-700"
          >{m.status_token_state_configured()}</span
        >{:else}<span data-testid="status-token-state" class="font-medium text-gray-500"
          >{m.status_token_state_not_configured()}</span
        >{/if}
    </p>
    {#if createdAt}
      <p class="mt-1 text-xs text-gray-500">
        {m.status_token_created_label({
          date: new Date(createdAt).toLocaleString(),
        })}
        {#if lastUsedAt}
          {m.status_token_last_used_label({
            date: new Date(lastUsedAt).toLocaleString(),
          })}
        {/if}
      </p>
    {/if}<InjectionPoint name="platform.settings.status-token-state" {data} />
  </div>
</RegionFragment>
