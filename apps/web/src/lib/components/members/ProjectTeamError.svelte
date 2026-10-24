<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import type { InjectionPointExtras } from '$lib/components/composition/injection-points.js'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'

  // Story 69.11: why the last member change (role, removal, ownership transfer) failed.
  let {
    memberError,
    pointProps,
    data,
  }: {
    memberError: string | null
    pointProps: InjectionPointExtras<'project.members.header'>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.members.team-error -->
<RegionFragment>
  {#if memberError}
    <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
      {memberError}
    </p>
  {/if}<InjectionPoint name="project.members.team-error" props={pointProps} {data} />
</RegionFragment>
