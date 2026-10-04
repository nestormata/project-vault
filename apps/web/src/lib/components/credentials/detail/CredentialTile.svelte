<!--
  One labelled figure (`<dt>`/`<dd>`) of the credential header's metadata grid. The four tiles share
  this markup; `children` is the value.
-->
<script lang="ts">
  import type { Snippet } from 'svelte'

  let { label, children }: { label: string; children: Snippet } = $props()
</script>

<div class="rounded-2xl bg-slate-50 p-4">
  <dt class="text-sm text-slate-500">{label}</dt>
  <dd class="font-medium text-slate-950">{@render children()}</dd>
</div>
