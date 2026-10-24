<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import type { ProjectImportFlow } from './project-import-flow.svelte.js'

  // Story 69.11: the optional project name override of the project import form.
  let {
    flow,
    data,
  }: {
    flow: ProjectImportFlow
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.import.name -->
<div>
  <label class="block text-sm font-medium text-slate-800" for="project-name">
    Project name (optional override)
  </label>
  <input
    id="project-name"
    type="text"
    class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
    bind:value={flow.projectName}
    placeholder="Defaults to the exported project's own name"
    aria-describedby="project-name-help"
  />
  <FormHelpText
    id="project-name-help"
    text="Leave blank to keep the exported project's original name. Importing always creates a brand-new project — it never overwrites or merges into an existing one."
  /><InjectionPoint name="project.import.name" {data} />
</div>
