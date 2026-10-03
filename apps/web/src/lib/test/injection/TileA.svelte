<script lang="ts">
  let {
    routeId = null,
    params = {},
    project = null,
    data = null,
  }: {
    routeId?: string | null
    params?: Record<string, string>
    project?: { name?: string } | null
    data?: unknown
  } = $props()
</script>

<p
  id="a"
  data-route={routeId}
  data-param={params.projectId ?? ''}
  data-project={project?.name ?? ''}
>
  A {JSON.stringify(data)}
</p>
