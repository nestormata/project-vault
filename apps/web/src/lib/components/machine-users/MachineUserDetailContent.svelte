<script lang="ts">
  import type { PageData } from '../../../routes/(app)/projects/[projectId]/machine-users/[machineUserId]/$types.js'
  import type { Snippet } from 'svelte'
  import { canManageMachineUsers } from '$lib/machine-users/permissions.js'
  import NavLink from '$lib/navigation/NavLink.svelte'
  import PageAlertBanner from '$lib/components/PageAlertBanner.svelte'
  import MachineUserKeyIssue from './MachineUserKeyIssue.svelte'
  import MachineUserKeyReveal from './MachineUserKeyReveal.svelte'
  import MachineUserKeysList from './MachineUserKeysList.svelte'
  import MachineUserSummary from './MachineUserSummary.svelte'
  import { MachineUserKeys } from './machine-user-keys.svelte.js'
  import type { PointData } from './machine-user-detail.js'

  // Story 69.14: the machine user detail is its not-found banner plus five sub-regions (summary,
  // deactivate inside it, key reveal, key issue, key list), each hosting its own point. The page's
  // loaded data stays `pageData`; `data` is the page's `__inject` map. This component owns the API
  // key state (one controller) so that the reveal, issue and list regions share it.
  let { pageData, data, children }: { pageData: PageData; data?: PointData; children?: Snippet } =
    $props()

  const canManage = $derived(canManageMachineUsers(pageData.orgRole))
  const isDeactivated = $derived(pageData.machineUser?.deactivatedAt != null)
  const keys = new MachineUserKeys(
    () => pageData.machineUserId,
    () => canManage
  )
</script>

<section class="space-y-6">
  {#if pageData.notFound || !pageData.machineUser}
    <PageAlertBanner
      title="Machine user not found"
      message="This machine user does not exist or you do not have access."
      backHref={`/projects/${pageData.projectId}/machine-users`}
      backLabel="Back to machine users"
    />
  {:else}
    <MachineUserSummary
      machineUser={pageData.machineUser}
      machineUserId={pageData.machineUserId}
      {isDeactivated}
      {canManage}
      {data}
    />

    <MachineUserKeyReveal {keys} {data} />

    <MachineUserKeyIssue {keys} show={canManage && !isDeactivated} {data} />

    <MachineUserKeysList items={pageData.apiKeys.items} {canManage} {keys} {data} />

    <NavLink
      surface="back"
      node="back.project.machine-user"
      class="inline-block font-medium text-slate-700 underline"
      projectId={pageData.projectId}
    />
  {/if}
</section>
{@render children?.()}
