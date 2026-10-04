<script lang="ts">
  import type { Snippet } from 'svelte'

  // The card shell shared by the dashboard's list sections (upcoming rotations, recent activity).
  let { heading, children }: { heading: string; children: Snippet } = $props()
</script>

<section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <h2 class="text-lg font-semibold text-slate-950">
    {heading}
  </h2>
  {@render children()}
</section>
