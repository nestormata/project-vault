<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import type { InjectionPointExtras } from '$lib/components/composition/injection-points.js'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import type { ProjectMember } from '$lib/api/org-users.js'

  // Story 69.11: the transfer-ownership row of the "Team members" card. The page owns the selected
  // target (bindable) and the transfer itself.
  let {
    nonOwnerMembers,
    memberBusyId,
    transferTarget = $bindable(),
    onTransfer,
    pointProps,
    data,
  }: {
    nonOwnerMembers: readonly ProjectMember[]
    memberBusyId: string | null
    transferTarget: string
    onTransfer: () => void
    pointProps: InjectionPointExtras<'project.members.header'>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.members.team-transfer -->
<div class="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
  <label class="font-medium text-slate-900" for="transfer-owner">Transfer ownership</label>
  <select
    id="transfer-owner"
    class="rounded-lg border border-slate-300 px-2 py-1 text-sm"
    bind:value={transferTarget}
    aria-describedby="transfer-owner-help"
  >
    <option value="">Select a member…</option>
    {#each nonOwnerMembers as member (member.userId)}
      <option value={member.userId}>{member.email}</option>
    {/each}
  </select>
  <FormHelpText id="transfer-owner-help" kind="select" />
  <button
    class="rounded-xl bg-slate-950 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
    type="button"
    disabled={!transferTarget || memberBusyId !== null}
    onclick={() => onTransfer()}
  >
    Transfer
  </button><InjectionPoint name="project.members.team-transfer" props={pointProps} {data} />
</div>
