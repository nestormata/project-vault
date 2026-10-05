<script lang="ts">
  import type { Snippet } from 'svelte'

  let { children }: { children?: Snippet } = $props()
</script>

<div>
  <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">New project</p>
  <h1 class="mt-2 text-3xl font-bold text-slate-950">Create a project</h1>
  <p class="mt-2 text-slate-600">
    Projects group secrets, services, certificates, and future rotation work by team or domain.
  </p>
</div>
{@render children?.()}
