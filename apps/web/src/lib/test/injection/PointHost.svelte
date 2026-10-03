<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import type { InjectionEntry } from '$lib/components/composition/injection-points.js'
  import type { getProject } from '$lib/api/projects.js'

  let {
    entries,
    data,
    withFallback = false,
    project = null,
  }: {
    entries?: readonly InjectionEntry[]
    data?: Record<string, readonly unknown[]>
    withFallback?: boolean
    project?: Awaited<ReturnType<typeof getProject>> | null
  } = $props()
</script>

<section id="host">
  <InjectionPoint name="project.detail.before" props={{ project }} {data} {entries}>
    {#snippet fallback()}
      {#if withFallback}<i id="fallback">fallback</i>{/if}
    {/snippet}
  </InjectionPoint>
</section>
