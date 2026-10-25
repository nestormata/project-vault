<script lang="ts">
  import { thresholdClass } from './resource-usage-format.js'

  // Story 69.14: a "current / limit (pct%)" figure coloured by its utilization threshold.
  let { text, pct }: { text: string; pct: number | null } = $props()
</script>

<span class={thresholdClass(pct)}>
  {text}
  {#if pct !== null}({pct}%){/if}
</span>
