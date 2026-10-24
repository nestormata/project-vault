<script lang="ts">
  import type { ListCredentialDependenciesResponse } from '$lib/api/credentials.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'

  // Story 69.14: the "Dependent systems" card of the start-rotation page as one replaceable region.
  let {
    dependencies,
    data,
  }: {
    dependencies: ListCredentialDependenciesResponse
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.credentials-rotate.dependencies -->
<RegionFragment>
  <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
    <h2 class="text-lg font-semibold text-slate-950">Dependent systems</h2>
    {#if dependencies.hasDependencies}
      <p class="mt-2 text-sm text-slate-600">
        This rotation will create a checklist item for each of these {dependencies.items.length} systems:
      </p>
      <ul class="mt-3 space-y-1 text-sm text-slate-800">
        {#each dependencies.items as dependency (dependency.id)}
          <li>{dependency.systemName}</li>
        {/each}
      </ul>
    {:else}
      <p class="mt-2 text-sm text-slate-600">
        No dependent systems are recorded for this secret. The rotation will still be created, but
        the checklist will be empty — you'll need to explicitly acknowledge that before completing
        it.
      </p>
    {/if}<InjectionPoint name="project.credentials-rotate.dependencies" {data} />
  </section>
</RegionFragment>
