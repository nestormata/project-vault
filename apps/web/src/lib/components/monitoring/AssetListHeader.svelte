<!--
  Header card at the top of a monitored-asset list page: eyebrow label, title, description, and an
  optional "Add X" link (hidden unless `canManage`). Shared by the certificates/domains/services/
  service-endpoints list pages, which only differ in copy and the add-link's href/label.
-->
<script lang="ts">
  import { resolve } from '$app/paths'

  let {
    eyebrow,
    title,
    addHref,
    addLabel,
    canManage,
    children,
  }: {
    eyebrow: string
    title: string
    addHref: string
    addLabel: string
    canManage: boolean
    children: import('svelte').Snippet
  } = $props()
</script>

<div
  class="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between"
>
  <div>
    <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">{eyebrow}</p>
    <h1 class="mt-2 text-3xl font-bold text-slate-950">{title}</h1>
    <p class="mt-2 text-slate-600">{@render children()}</p>
  </div>
  {#if canManage}
    <a
      class="rounded-xl bg-slate-950 px-4 py-3 text-center font-semibold text-white"
      href={resolve(addHref)}
    >
      {addLabel}
    </a>
  {/if}
</div>
