<script lang="ts">
  import PlatformUsageFigure from './PlatformUsageFigure.svelte'

  // Story 69.14: a "current / limit (pct%)" figure coloured by its utilization threshold.
  let { text, pct }: { text: string; pct: number | null } = $props()
</script>

<p class="mt-2 text-sm">
  <PlatformUsageFigure {text} {pct} />
</p>
