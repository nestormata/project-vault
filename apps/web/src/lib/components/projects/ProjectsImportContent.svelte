<script lang="ts">
  import type { Snippet } from 'svelte'
  import ProjectsImportDone from './ProjectsImportDone.svelte'
  import ProjectsImportError from './ProjectsImportError.svelte'
  import ProjectsImportFile from './ProjectsImportFile.svelte'
  import ProjectsImportExportKey from './ProjectsImportExportKey.svelte'
  import ProjectsImportName from './ProjectsImportName.svelte'
  import ProjectsImportSubmit from './ProjectsImportSubmit.svelte'
  import { ProjectImportFlow } from './project-import-flow.svelte.js'

  // Story 69.11: the import page body is the form (error banner, export file, export key, name
  // override, submit row) or, once imported, the success panel; each section is a sub-region.
  // `ProjectImportFlow` is the one owner of the form state; `data` is the page's `__inject` map.
  let {
    data,
    children,
  }: {
    data?: Record<string, readonly unknown[]> | undefined
    children?: Snippet
  } = $props()

  const flow = new ProjectImportFlow()
</script>

{@render children?.()}
{#if flow.result}
  <ProjectsImportDone result={flow.result} onView={() => flow.goToImportedProject()} {data} />
{:else}
  <form
    method="post"
    class="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
    onsubmit={(event) => {
      event.preventDefault()
      void flow.submit()
    }}
  >
    <ProjectsImportError errorMessage={flow.errorMessage} {data} />

    <ProjectsImportFile {flow} {data} />

    <ProjectsImportExportKey {flow} {data} />

    <ProjectsImportName {flow} {data} />

    <ProjectsImportSubmit {flow} {data} />
  </form>
{/if}
