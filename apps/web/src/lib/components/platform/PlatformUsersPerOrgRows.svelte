<script lang="ts">
  import { pct, thresholdClass, thresholdLabel } from './resource-usage-format.js'

  let {
    usersPerOrg,
  }: { usersPerOrg: Array<{ orgId: string; current: number; limit: number | null }> } = $props()
</script>

<div class="mt-2 divide-y divide-gray-100">
  {#each usersPerOrg as row (row.orgId)}
    {@const userPct = pct(row.current, row.limit)}
    <div class="flex items-center justify-between py-2 text-sm">
      <span class="font-mono text-xs text-gray-500">{row.orgId}</span>
      <span class={thresholdClass(userPct)}>
        {row.current} / {row.limit ?? 'No limit'}
        {#if userPct !== null}({userPct}%){/if}
        {#if thresholdLabel(userPct)}<span class="ml-1 text-xs font-semibold"
            >{thresholdLabel(userPct)}</span
          >{/if}
      </span>
    </div>
  {/each}
</div>
