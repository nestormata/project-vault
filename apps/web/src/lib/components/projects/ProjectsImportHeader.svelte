<script lang="ts">
  import type { Snippet } from 'svelte'

  let { children }: { children?: Snippet } = $props()
</script>

<div class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
  <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Projects</p>
  <h1 class="mt-2 text-3xl font-bold text-slate-950">Import project</h1>
  <p class="mt-2 text-slate-600">
    Upload a <code>.pvexport</code> file and its matching export key to create a brand-new project in
    your organization from it. This never merges into an existing project.
  </p>
</div>
{@render children?.()}
