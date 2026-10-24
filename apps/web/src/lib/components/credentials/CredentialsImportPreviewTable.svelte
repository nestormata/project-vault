<script lang="ts">
  import type { ImportPreview } from '$lib/api/credentials.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'

  // Story 69.11: the parsed items of a secrets import preview, with their conflicts and the action
  // the import would take.
  let {
    parsed,
    data,
  }: {
    parsed: ImportPreview['parsed']
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.credentials-import.preview-table -->
<RegionFragment>
  <div class="overflow-hidden rounded-xl border border-slate-200">
    <table class="min-w-full text-left text-sm">
      <thead class="border-b border-slate-200 bg-slate-50 text-slate-600">
        <tr>
          <th class="px-4 py-3 font-semibold">Name</th>
          <th class="px-4 py-3 font-semibold">Value</th>
          <th class="px-4 py-3 font-semibold">Conflict</th>
          <th class="px-4 py-3 font-semibold">Suggested action</th>
        </tr>
      </thead>
      <tbody>
        {#each parsed as item (item.name)}
          <tr class="border-b border-slate-100 last:border-b-0">
            <td class="px-4 py-3 font-medium">{item.name}</td>
            <td class="px-4 py-3 font-mono text-slate-600">{item.value}</td>
            <td class="px-4 py-3 text-slate-600">{item.conflictName ?? '—'}</td>
            <td class="px-4 py-3 text-slate-600">{item.suggestedAction}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <InjectionPoint name="project.credentials-import.preview-table" {data} />
</RegionFragment>
