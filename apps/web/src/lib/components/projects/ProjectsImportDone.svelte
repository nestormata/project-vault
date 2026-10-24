<script lang="ts">
  import { resolve } from '$app/paths'
  import type { ImportProjectResult } from '$lib/api/project-export.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import * as m from '$lib/paraglide/messages.js'
  import { importedCountRows } from './project-import-counts.js'

  // Story 69.11: the success panel shown once a project export was imported.
  let {
    result,
    onView,
    data,
  }: {
    result: ImportProjectResult
    onView: () => void
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  const countRows = $derived(importedCountRows(result.importedCounts))
</script>

<!-- @region project.import.done -->
<RegionFragment>
  <div class="rounded-2xl border border-emerald-300 bg-emerald-50 p-6">
    <h2 class="text-lg font-semibold text-emerald-900">Import complete</h2>
    <p class="mt-2 text-sm text-emerald-800">
      {m.project_import_success_intro()} <strong>{result.name}</strong>
    </p>
    {#if countRows.length > 0}
      <ul class="mt-2 list-disc pl-5 text-sm text-emerald-800">
        {#each countRows as row (row.label)}
          <li>{row.label}: {row.count}</li>
        {/each}
      </ul>
    {:else}
      <p class="mt-2 text-sm text-emerald-800">{m.project_import_no_items()}</p>
    {/if}
    <div class="mt-4 flex flex-wrap items-center gap-4">
      <button
        type="button"
        class="rounded-lg bg-emerald-900 px-4 py-2 text-sm font-semibold text-white"
        onclick={onView}
      >
        View project
      </button>
      <a class="text-sm font-medium text-emerald-900 underline" href={resolve('/projects')}>
        {m.project_import_back_to_projects()}
      </a><InjectionPoint name="project.import.done" {data} />
    </div>
  </div>
</RegionFragment>
