<script lang="ts">
  import { resolve } from '$app/paths'

  // The "no projects yet" empty state of the credentials pages, ending in a create-project link.
  let { title, message }: { title?: string; message: string } = $props()
</script>

<div class="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6">
  {#if title}
    <h2 class="text-xl font-semibold text-slate-950">{title}</h2>
    <p class="mt-2 text-slate-600">{message}</p>
  {:else}
    <p class="text-slate-600">{message}</p>
  {/if}
  <a class="mt-4 inline-block font-medium text-slate-950 underline" href={resolve('/projects/new')}>
    Create project
  </a>
</div>
