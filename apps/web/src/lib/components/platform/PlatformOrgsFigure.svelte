<script lang="ts">
  import { thresholdClass, thresholdLabel } from './resource-usage-format.js'

  // Story 69.14: the organizations "current / limit (pct%)" figure with its threshold label.
  let { text, pct }: { text: string; pct: number | null } = $props()
</script>

<p class="mt-2 text-sm">
  <span class={thresholdClass(pct)}>
    {text}
    {#if pct !== null}({pct}%){/if}
  </span>
  {#if thresholdLabel(pct)}
    <span class="ml-2 text-xs font-semibold">{thresholdLabel(pct)}</span>
  {/if}
</p>
