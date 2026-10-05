<script lang="ts">
  import ProjectsListHeader from '$lib/components/projects/ProjectsListHeader.svelte'
  import ProjectsListError from '$lib/components/projects/ProjectsListError.svelte'
  import ProjectsListContent from '$lib/components/projects/ProjectsListContent.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  import { goto, invalidateAll } from '$app/navigation'

  import { page } from '$app/state'

  let { data } = $props()

  let errorMessage = $state<string | null>(null)

  // Story 18.4 AC-1: this button had no re-entrancy guard at all — unlike every sibling action on
  // this page (onArchive/onUnarchive/onSaveTags below all check a busy flag before doing
  // anything) — even though it reads `data.includeArchived` to decide its next target, and `data`
  // only reflects the new state once `goto(..., { invalidateAll: true })` actually resolves. A
  // second click fired before that resolution read the same stale value instead of the button's
  // own just-issued intent, so rapid clicks didn't accumulate as alternating toggles. `togglingArchived`
  // closes that gap the same way every other action handler on this page already does.
  let togglingArchived = $state(false)

  async function toggleShowArchived(): Promise<void> {
    if (togglingArchived) return
    togglingArchived = true
    try {
      const params = new URLSearchParams(page.url.searchParams)
      if (data.includeArchived) {
        params.delete('includeArchived')
      } else {
        params.set('includeArchived', 'true')
      }
      const query = params.toString()
      // Dynamic query string toggle on the current route — not a literal resolve() can type-check.
      // eslint-disable-next-line svelte/no-navigation-without-resolve
      await goto(query ? `?${query}` : '?', { invalidateAll: true })
    } finally {
      togglingArchived = false
    }
  }
</script>

<svelte:head>
  <title>Projects | Project Vault</title>
</svelte:head>

<InjectionPoint name="project.home.before" data={data?.__inject} />
<InjectionPoint name="project.home.header.actions" data={data?.__inject} />
<section class="space-y-6">
  <!-- @region project.home.header -->
  <ProjectsListHeader
    {togglingArchived}
    includeArchived={data.includeArchived}
    {toggleShowArchived}
  >
    <InjectionPoint name="project.home.header" data={data?.__inject} />
  </ProjectsListHeader>

  <!-- @region project.home.error -->
  <ProjectsListError {errorMessage}>
    <InjectionPoint name="project.home.error" data={data?.__inject} />
  </ProjectsListError>

  <!-- @region project.home.list -->
  <ProjectsListContent projects={data.projects.items} bind:errorMessage>
    <InjectionPoint name="project.home.list" data={data?.__inject} />
  </ProjectsListContent>
</section>
<InjectionPoint name="project.home.after" data={data?.__inject} />
