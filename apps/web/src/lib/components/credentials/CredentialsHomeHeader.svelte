<script lang="ts">
  import type { Snippet } from 'svelte'
  import { resolve } from '$app/paths'

  let { children }: { children?: Snippet } = $props()
</script>

<div
  class="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between"
>
  <div>
    <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Secrets</p>
    <h1 class="mt-2 text-3xl font-bold text-slate-950">Choose a project</h1>
    <p class="mt-2 text-slate-600">
      Secrets live inside projects — pick a project to manage secrets.
    </p>
  </div>
  <a
    class="rounded-xl bg-slate-950 px-4 py-3 text-center font-semibold text-white"
    href={resolve('/projects/new')}
  >
    Create project
  </a>
</div>
{@render children?.()}
