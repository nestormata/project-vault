<script lang="ts">
  import type { OrgUser } from '$lib/api/org-users.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import UsersRow from './UsersRow.svelte'
  import { UsersActions } from './users-actions.svelte.js'

  // Story 69.10: the users table (error and transfer banners plus the table) as one replaceable
  // region. It creates the ONE `UsersActions` that owns every row's state (busy key, open panels,
  // rotation follow-ups); the rows and their sections receive it as a prop. Its point sits between
  // the banners and the table (a point after a block element would add a whitespace text node).
  let {
    users,
    orgRole,
    nativeLoginEnabled,
    data,
  }: {
    users: readonly OrgUser[]
    orgRole: string
    nativeLoginEnabled: boolean
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  const actions = new UsersActions(() => ({ users }))
</script>

<!-- @region settings.users.table -->
<RegionFragment>
  {#if actions.errorMessage}
    <p
      class="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"
      role="alert"
    >
      {actions.errorMessage}
    </p>
  {/if}

  {#if actions.transferNotice}
    <p
      class="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"
      role="status"
    >
      {actions.transferNotice}
    </p>
  {/if}<InjectionPoint name="settings.users.table" {data} />

  <div class="mt-8 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
    <table class="min-w-full text-left text-sm">
      <thead class="border-b border-slate-200 bg-slate-50 text-slate-600">
        <tr>
          <th class="px-4 py-3 font-semibold">User</th>
          <th class="px-4 py-3 font-semibold">Org role</th>
          <th class="px-4 py-3 font-semibold">Projects</th>
          <th class="px-4 py-3 font-semibold"></th>
        </tr>
      </thead>
      <tbody>
        {#each users as user (user.userId)}
          <UsersRow {actions} {user} {orgRole} {nativeLoginEnabled} />
        {:else}
          <tr>
            <td class="px-4 py-6 text-center text-slate-600" colspan="4">No users found.</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</RegionFragment>
