<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import type { StatusPageAdminPointProps } from '$lib/components/composition/injection-points.js'
  import StatusPageReadOnlyNotice from './StatusPageReadOnlyNotice.svelte'

  // Story 69.3: the notice a member who cannot manage the page sees, as one replaceable region. It
  // renders only when the caller cannot manage (and then none of the manage regions render). A
  // contribution at `project.status-page.read-only` receives `{ project, capabilities, serviceEndpoints }`.
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

<!-- @region project.status-page.read-only -->
<div class="rounded-2xl border border-slate-200 bg-slate-50 p-6">
  <StatusPageReadOnlyNotice /><InjectionPoint
    name="project.status-page.read-only"
    props={{ project, capabilities, serviceEndpoints }}
    {data}
  />
</div>
