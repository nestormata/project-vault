<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import * as m from '$lib/paraglide/messages.js'
  import ProjectsImportFilePicker from './ProjectsImportFilePicker.svelte'
  import type { ProjectImportFlow } from './project-import-flow.svelte.js'

  // Story 69.11: the export file field of the project import form (picker, type warning, help).
  let {
    flow,
    data,
  }: {
    flow: ProjectImportFlow
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.import.file -->
<div>
  <label class="block text-sm font-medium text-slate-800" for="pvexport-file">
    Export file (.pvexport)
  </label>
  <ProjectsImportFilePicker {flow} />
  {#if flow.fileBadType}
    <p role="alert" class="mt-1 text-sm text-red-700">{m.project_import_file_bad_type()}</p>
  {/if}
  <FormHelpText id="pvexport-file-help" text={m.project_import_file_help()} /><InjectionPoint
    name="project.import.file"
    {data}
  />
</div>
