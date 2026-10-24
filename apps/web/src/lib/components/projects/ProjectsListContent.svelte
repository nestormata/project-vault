<script lang="ts">
  import type { ProjectListPage } from '$lib/api/projects.js'
  import type { Snippet } from 'svelte'
  import ProjectsListResults from './ProjectsListResults.svelte'
  import { ProjectsListActions } from './projects-list-actions.svelte.js'

  // Story 69.11: the list is the page-level error banner's owner plus one results sub-region.
  // `ProjectsListActions` owns the state the cards share (busy project, tag inputs and errors) and
  // writes `errorMessage`; `data` is the route's `__inject` map.
  let {
    projects,
    errorMessage = $bindable(),
    data,
    children,
  }: {
    projects: ProjectListPage['items']
    errorMessage: string | null
    data?: Record<string, readonly unknown[]> | undefined
    children?: Snippet
  } = $props()

  const actions = new ProjectsListActions((message) => {
    errorMessage = message
  })
</script>

{@render children?.()}
<ProjectsListResults {projects} {actions} {data} />
