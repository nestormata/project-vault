<!--
  Title card at the top of a monitored-asset detail page: eyebrow label, the entity's display
  name, and an optional extra note paragraph (e.g. services' "renaming isn't supported" caveat).
-->
<script lang="ts">
  let {
    eyebrow,
    title,
    note,
  }: {
    eyebrow: string
    title: string
    note?: string
  } = $props()
</script>

<div class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
  <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">{eyebrow}</p>
  <h1 class="mt-2 text-3xl font-bold text-slate-950">{title}</h1>
  {#if note}
    <p class="mt-2 text-sm text-slate-500">{note}</p>
  {/if}
</div>
