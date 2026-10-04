<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import StatusPageHeaderCard from './StatusPageHeaderCard.svelte'
  import type { StatusPageRegionProps } from './region-props.js'

  // Story 69.3: the status page admin header card as one replaceable region. A contribution at
  // `project.status-page.header` receives `{ project, capabilities, serviceEndpoints }` and renders inside the card, after the text.
  let { project, capabilities, serviceEndpoints, data }: StatusPageRegionProps = $props()
</script>

<!-- @region project.status-page.header -->
<div class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
  <StatusPageHeaderCard /><InjectionPoint
    name="project.status-page.header"
    props={{ project, capabilities, serviceEndpoints }}
    {data}
  />
</div>
