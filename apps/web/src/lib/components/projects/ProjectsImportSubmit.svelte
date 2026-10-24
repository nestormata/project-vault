<script lang="ts">
  import { resolve } from '$app/paths'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import * as m from '$lib/paraglide/messages.js'
  import type { ProjectImportFlow } from './project-import-flow.svelte.js'

  // Story 69.11: the submit row of the project import form.
  let {
    flow,
    data,
  }: {
    flow: ProjectImportFlow
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.import.submit -->
<div class="flex flex-wrap items-center gap-4">
  <button
    type="submit"
    class="rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
    disabled={!flow.selectedFile || !flow.exportKey.trim() || flow.importing}
  >
    {flow.importing ? 'Importing…' : 'Import project'}
  </button>
  <a class="text-sm font-medium text-slate-700 underline" href={resolve('/projects')}>
    {m.project_import_back_to_projects()}
  </a><InjectionPoint name="project.import.submit" {data} />
</div>
