<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import type { EndpointRolePointProps } from '$lib/components/composition/injection-points.js'
  import ServiceEndpointNewTitle from './ServiceEndpointNewTitle.svelte'

  // Story 69.3: the "Add endpoint" page header as one replaceable region. A contribution at
  // `project.service-endpoints-new.header` receives `{ project, orgRole }` and renders inside the header
  // block, after the heading.
  let {
    project,
    orgRole,
    data,
  }: {
    project: EndpointRolePointProps['project']
    orgRole: EndpointRolePointProps['orgRole']
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.service-endpoints-new.header -->
<div>
  <ServiceEndpointNewTitle /><InjectionPoint
    name="project.service-endpoints-new.header"
    props={{ project, orgRole }}
    {data}
  />
</div>
