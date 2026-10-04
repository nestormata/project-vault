<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import ProjectNav from '$lib/components/shell/ProjectNav.svelte'
  import type { LayoutData } from './$types.js'

  let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props()
</script>

<div class="space-y-6">
  <ProjectNav
    projectId={data.projectId}
    orgRole={data.orgRole}
    isArchived={data.project?.archivedAt != null}
    project={data.project}
    data={data.__inject}
  />
  <InjectionPoint
    name="project.layout.before"
    props={{ project: data.project }}
    data={data.__inject}
  />
  <InjectionPoint
    name="project.layout.header.actions"
    props={{ project: data.project }}
    data={data.__inject}
  />
  {@render children()}<InjectionPoint
    name="project.layout.after"
    props={{ project: data.project }}
    data={data.__inject}
  />
</div>
