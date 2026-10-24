<script lang="ts">
  import { resolve } from '$app/paths'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'

  // Story 69.11: the summary shown once a secrets import completed.
  let {
    summary,
    projectId,
    data,
  }: {
    summary: { imported: number; newVersions: number; skipped: number }
    projectId: string
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.credentials-import.done -->
<RegionFragment>
  <div class="rounded-2xl border border-emerald-200 bg-emerald-50 p-6">
    <h2 class="text-lg font-semibold text-emerald-900">Import complete</h2>
    <ul class="mt-3 space-y-1 text-emerald-800">
      <li>Imported: {summary.imported}</li>
      <li>New versions: {summary.newVersions}</li>
      <li>Skipped: {summary.skipped}</li>
    </ul>
    <a
      class="mt-4 inline-block rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white"
      href={resolve(`/projects/${projectId}/credentials`)}
    >
      View secrets
    </a><InjectionPoint name="project.credentials-import.done" {data} />
  </div>
</RegionFragment>
