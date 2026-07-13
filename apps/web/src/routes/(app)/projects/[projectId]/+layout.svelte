<script lang="ts">
  import ProjectNav from '$lib/components/shell/ProjectNav.svelte'
  import type { LayoutData } from './$types.js'

  let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props()
</script>

<div class="space-y-6">
  <ProjectNav
    projectId={data.projectId}
    orgRole={data.orgRole}
    isArchived={data.project?.archivedAt != null}
  />
  {@render children()}
</div>
