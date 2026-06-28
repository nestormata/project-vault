<script lang="ts">
  import { getPlaceholderSection } from './placeholder-copy.js'

  let { section } = $props()
  let copy = $derived(getPlaceholderSection(section))
</script>

<section class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
  <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Coming later</p>
  <h1 class="mt-2 text-3xl font-bold text-slate-950">{copy.title}</h1>
  <p class="mt-3 text-slate-600">{copy.copy}</p>
</section>
