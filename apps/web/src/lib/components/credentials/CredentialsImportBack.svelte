<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import NavLink from '$lib/navigation/NavLink.svelte'

  // Story 69.11: the back link of the import page. The page renders it only for a caller who can
  // import and not once the import is done.
  let {
    projectId,
    data,
  }: {
    projectId: string
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.credentials-import.back -->
<RegionFragment>
  <NavLink
    surface="back"
    node="back.project.credentials.import"
    class="inline-block font-medium text-slate-700 underline"
    {projectId}
  /><InjectionPoint name="project.credentials-import.back" {data} />
</RegionFragment>
