<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import ProjectNotFoundMessage from './ProjectNotFoundMessage.svelte'

  // Story 69.1: the project page's "not found" card as one replaceable region. Rendered for a 404
  // and for a foreign project id alike, so it receives `project: null` and nothing else.
  let { data }: { data?: Record<string, readonly unknown[]> | undefined } = $props()
</script>

<!-- @region project.detail.not-found -->
<section class="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6">
  <ProjectNotFoundMessage /><InjectionPoint
    name="project.detail.not-found"
    props={{ project: null }}
    {data}
  />
</section>
