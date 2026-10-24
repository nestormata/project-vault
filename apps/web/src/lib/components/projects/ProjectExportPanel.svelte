<script lang="ts">
  import type { ProjectOverview } from '@project-vault/shared'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import ProjectExportError from './ProjectExportError.svelte'
  import ProjectExportIntro from './ProjectExportIntro.svelte'
  import ProjectExportKeyFlow from './ProjectExportKeyFlow.svelte'

  // Story 69.1: the "Export project" section as one replaceable region. Story 69.12: the
  // description, the failure message and the export itself (with the one-time reveal) are
  // sub-regions. The export key, `exporting` and the copy status live in `ProjectExportKeyFlow`
  // and never leave it (Story 62-2 D3): this panel only holds whether a reveal is open and the
  // failure message, and every point (this one and the sub-regions') receives `{ project }` ONLY.
  let {
    project,
    data,
  }: { project: ProjectOverview; data?: Record<string, readonly unknown[]> | undefined } = $props()

  let revealed = $state(false)
  let exportError = $state<string | null>(null)
</script>

<!-- @region project.detail.export -->
<section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <h2 class="text-lg font-semibold text-slate-950">Export project</h2>
  <ProjectExportIntro {project} {revealed} {data} />
  <ProjectExportError {project} {exportError} {data} />
  <ProjectExportKeyFlow {project} bind:revealed bind:exportError {data} /><InjectionPoint
    name="project.detail.export"
    props={{ project }}
    {data}
  />
</section>
