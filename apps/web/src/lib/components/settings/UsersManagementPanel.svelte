<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { OrgUser } from '$lib/api/org-users.js'
  import UsersDefaultLanguage from './UsersDefaultLanguage.svelte'
  import UsersMachineDormancy from './UsersMachineDormancy.svelte'
  import UsersTable from './UsersTable.svelte'
  import UsersUserDormancy from './UsersUserDormancy.svelte'

  // Story 69.10: the access gate plus its sections (machine-key dormancy, user dormancy, default
  // language, users table), each a sub-region that owns its own state. The page hands over the few
  // fields the sections need and its `__inject` map as `data`.
  let {
    canManage,
    orgId,
    orgRole,
    users,
    nativeLoginEnabled,
    data,
    children,
  }: {
    canManage: boolean
    orgId: string
    orgRole: string
    users: readonly OrgUser[]
    /** Story 23.2 AC-6 row #10 / G3: default true (fail-safe, byte-identical-to-today). */
    nativeLoginEnabled?: boolean
    data?: Record<string, readonly unknown[]> | undefined
    children?: Snippet
  } = $props()
</script>

{@render children?.()}
{#if !canManage}
  <div class="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-6">
    <p class="text-slate-600">Only organization owners and admins can manage users.</p>
  </div>
{:else}
  <UsersMachineDormancy {orgId} {data} />
  <UsersUserDormancy {orgId} {data} />
  <UsersDefaultLanguage {orgId} {data} />
  <UsersTable {users} {orgRole} nativeLoginEnabled={nativeLoginEnabled ?? true} {data} />
{/if}
