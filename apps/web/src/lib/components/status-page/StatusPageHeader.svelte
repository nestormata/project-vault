<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import type { StatusPageAdminPointProps } from '$lib/components/composition/injection-points.js'
  import StatusPageHeaderCard from './StatusPageHeaderCard.svelte'

  // Story 69.3: the status page admin header card as one replaceable region. A contribution at
  // `project.status-page.header` receives `{ project, capabilities, serviceEndpoints }` and renders inside the card, after the text.
  let {
    project,
    capabilities,
    serviceEndpoints,
    data,
  }: {
    project: StatusPageAdminPointProps['project']
    capabilities: StatusPageAdminPointProps['capabilities']
    serviceEndpoints: StatusPageAdminPointProps['serviceEndpoints']
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.status-page.header -->
<div class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
  <StatusPageHeaderCard /><InjectionPoint
    name="project.status-page.header"
    props={{ project, capabilities, serviceEndpoints }}
    {data}
  />
</div>
