<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import PlatformUsersPerOrgRows from './PlatformUsersPerOrgRows.svelte'

  // Story 69.14: the users-per-organization card as one replaceable region.
  let {
    usersPerOrg,
    data,
  }: {
    usersPerOrg: Array<{ orgId: string; current: number; limit: number | null }>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region platform.settings-resource-usage.users -->
<section class="rounded-xl border border-gray-200 bg-white p-6">
  <h2 class="text-base font-semibold text-gray-900">Users per Organization</h2>
  <PlatformUsersPerOrgRows {usersPerOrg} /><InjectionPoint
    name="platform.settings-resource-usage.users"
    {data}
  />
</section>
