<script lang="ts">
  import type { Snippet } from 'svelte'
  import { resolve } from '$app/paths'

  let {
    togglingArchived,
    includeArchived,
    toggleShowArchived,
    children,
  }: {
    togglingArchived: boolean
    includeArchived: boolean
    toggleShowArchived: () => Promise<void>
    children?: Snippet
  } = $props()
</script>

<div
  class="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between"
>
  <div>
    <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Projects</p>
    <h1 class="mt-2 text-3xl font-bold text-slate-950">Project dashboard</h1>
    <p class="mt-2 text-slate-600">
      Organize secrets, services, and future alerts by team or domain.
    </p>
  </div>
  <div class="flex flex-col items-stretch gap-2 sm:items-end">
    <a
      class="rounded-xl bg-slate-950 px-4 py-3 text-center font-semibold text-white"
      href={resolve('/projects/new')}
    >
      Create project
    </a>
    <a
      class="rounded-xl border border-slate-300 px-4 py-3 text-center font-semibold text-slate-800"
      href={resolve('/projects/import')}
    >
      Import project
    </a>
    <button
      type="button"
      class="text-sm font-medium text-slate-600 underline disabled:cursor-not-allowed disabled:opacity-60"
      disabled={togglingArchived}
      aria-pressed={includeArchived}
      onclick={() => void toggleShowArchived()}
    >
      {includeArchived ? 'Hide archived' : 'Show archived'}
    </button>
  </div>
</div>
{@render children?.()}
