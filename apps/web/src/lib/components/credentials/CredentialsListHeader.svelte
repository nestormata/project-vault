<script lang="ts">
  import type { Snippet } from 'svelte'
  import { resolve } from '$app/paths'

  let {
    canCreate,
    canImport,
    projectId,
    children,
  }: { canCreate: boolean; canImport: boolean; projectId: string; children?: Snippet } = $props()
</script>

<div
  class="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between"
>
  <div>
    <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Secrets</p>
    <h1 class="mt-2 text-3xl font-bold text-slate-950">Project secrets</h1>
    <p class="mt-2 text-slate-600">Browse and manage secrets for this project.</p>
  </div>
  <div class="flex flex-col gap-2 sm:flex-row">
    {#if canCreate}
      <a
        class="rounded-xl bg-slate-950 px-4 py-3 text-center font-semibold text-white"
        href={resolve(`/projects/${projectId}/credentials/new`)}
      >
        Add secret
      </a>
    {/if}
    {#if canImport}
      <a
        class="rounded-xl border border-slate-300 px-4 py-3 text-center font-semibold text-slate-900"
        href={resolve(`/projects/${projectId}/credentials/import`)}
      >
        Import
      </a>
    {/if}
  </div>
</div>
{@render children?.()}
