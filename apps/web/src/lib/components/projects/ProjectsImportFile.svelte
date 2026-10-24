<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
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
  <ProjectsImportFilePicker {flow} /><InjectionPoint name="project.import.file" {data} />
</div>
