<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { CredentialDependenciesRegionProps } from './credential-dependencies-controller.svelte.js'
  import CredentialDependencyRow from './CredentialDependencyRow.svelte'

  // Story 69-14: the recorded dependent systems (the empty notice, or the checklist error and the
  // list of rows) as one replaceable region. The list and the busy flags are the controller's.
  let { controller, pointProps, data }: CredentialDependenciesRegionProps = $props()
</script>

<!-- @region credential.detail.dependencies-list -->
<RegionFragment>
  {#if controller.dependencyItems.length === 0}
    <p class="mt-3 text-sm text-slate-600">No dependent systems recorded.</p>
  {:else}
    {#if controller.checklistError}
      <p class="mt-3 text-sm text-red-700" role="alert">{controller.checklistError}</p>
    {/if}
    <ul class="mt-4 space-y-2">
      {#each controller.dependencyItems as dependency (dependency.id)}
        <CredentialDependencyRow {controller} {dependency} />
      {/each}
    </ul>
  {/if}<InjectionPoint name="credential.detail.dependencies-list" props={pointProps} {data} />
</RegionFragment>
